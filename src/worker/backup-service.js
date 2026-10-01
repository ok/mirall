// The local backup, kept running: a run soon after boot, one an hour, and one shortly after any change
// worth backing up (schedule-rules.js), never two at once. A run is skipped while no folder is set.
// A run takes the changes noted so far; changes that land while it runs wait for the next one, and a
// run that fails hands its changes back. On quit, a run in progress or a due one gets a short cutoff
// and is waited for no longer than that: one that runs out of time writes nothing, and the next start
// runs. The folder and the repository it holds are main's to keep: a new repository id is sent there.
import fs from 'bare-fs'
import b4a from 'b4a'
import path from 'bare-path'
import { Subsystem } from '../shared/core/subsystem.js'
import { AppError } from '../shared/core/errors.js'
import { CODES } from '../shared/contract/errors.js'
import { MAIN_REQUEST_FRAME, MAIN_REQUEST } from '../shared/contract/main-requests.js'
import { BACKUP_SETTING_GROUPS } from '../shared/contract/backup-settings.js'
import { backupWrapKey } from '../shared/core/store.js'
import { getAppVersionLabel, getBackupConfig } from '../shared/core/runtime-config.js'
import { FolderTarget } from '../shared/storage/backup/folder-target.js'
import { runBackup } from '../shared/storage/backup/backup-run.js'
import { openRepo } from '../shared/storage/backup/repo.js'
import { pruneRepo } from '../shared/storage/backup/prune.js'
import { initBackupHints, resetBackupHints } from '../shared/storage/backup/backup-hints.js'
import { nextRunAt, URGENCY } from '../shared/storage/backup/schedule-rules.js'

const BOOT_RUN_DELAY_MS = 2 * 60 * 1000
const INTERVAL_MS = 60 * 60 * 1000
const PRUNE_EVERY_MS = 24 * 60 * 60 * 1000
const QUIT_CUTOFF_MS = 700
const CONFIG_FILE = 'config.json'

const IDLE = Object.freeze({ lastSuccessAt: null, lastSnapshot: null, lastError: null, suspect: null })

function mergeDirty(a, b) {
  if (!a || !b) return a ?? b
  return {
    firstAt: Math.min(a.firstAt, b.firstAt),
    lastAt: Math.max(a.lastAt, b.lastAt),
    urgency: a.urgency === URGENCY.URGENT || b.urgency === URGENCY.URGENT ? URGENCY.URGENT : URGENCY.NORMAL,
  }
}

export class Backup extends Subsystem {
  constructor(name, deps) {
    super(name, deps)
    this.require('ipc', 'corestore', 'storagePath', 'installId')
  }

  async _open() {
    this.config = getBackupConfig()
    this.dirty = null
    this.lastRunAt = null
    this.lastPruneAt = 0
    this.running = null
    this.cutoffAt = null
    this.wake = null
    this.progress = { state: this.config.folder ? 'idle' : 'off', ...IDLE }
    initBackupHints((urgency) => this.note(urgency))
    this.timers.setTimeout(() => this.runSoon('boot'), this.deps.bootDelayMs ?? BOOT_RUN_DELAY_MS)
    this.timers.setInterval(() => this.runSoon('interval'), this.deps.intervalMs ?? INTERVAL_MS)
  }

  async _close() {
    resetBackupHints()
    this.cutoffAt = Date.now() + QUIT_CUTOFF_MS
    const flush = this.running ?? (this.dirty && this.config.folder ? this.attempt('quit') : null)
    if (!flush) return
    let timer = null
    const waited = new Promise((resolve) => { timer = this.timers.setTimeout(resolve, QUIT_CUTOFF_MS + 200) })
    await Promise.race([flush, waited])
    this.timers.clear(timer)
  }

  view() {
    return { enabled: true, folder: this.config.folder, repoId: this.config.repoId, ...this.progress }
  }

  note(urgency) {
    const now = Date.now()
    this.dirty = mergeDirty(this.dirty, { firstAt: now, lastAt: now, urgency })
    this.schedule()
  }

  schedule() {
    if (this.wake) this.timers.clear(this.wake)
    this.wake = null
    if (this.stopping || !this.config.folder) return
    const at = nextRunAt({
      firstDirtyAt: this.dirty?.firstAt ?? null,
      lastEventAt: this.dirty?.lastAt ?? 0,
      urgency: this.dirty?.urgency ?? URGENCY.NORMAL,
      lastRunAt: this.lastRunAt,
      now: Date.now(),
    })
    if (at !== null) this.wake = this.timers.setTimeout(() => this.runSoon('change'), at - Date.now())
  }

  runSoon(reason) {
    this.run(reason).catch((err) => this.log.warn('backup run failed:', err.message))
  }

  run(reason) {
    if (this.stopping || !this.config.folder) return Promise.resolve(this.view())
    return this.running ?? this.attempt(reason)
  }

  attempt(reason) {
    this.running = this.backUp(reason).finally(() => {
      this.running = null
      this.schedule()
    })
    return this.running
  }

  async backUp(reason) {
    const taken = this.dirty
    this.dirty = null
    const { folder, repoId } = this.config
    this.report({ state: 'running' })
    try {
      const result = await runBackup({
        store: this.deps.corestore(),
        storagePath: this.deps.storagePath,
        target: new FolderTarget(folder),
        wrapKey: backupWrapKey(),
        repoId,
        installId: this.deps.installId,
        appVersion: getAppVersionLabel(),
        config: this.settingsBytes(),
        stopAt: () => this.cutoffAt,
      })
      this.lastRunAt = Date.now()
      if (this.config.folder !== folder) return this.view()
      if (result.repoId !== repoId) this.remember({ folder, repoId: result.repoId })
      this.report({
        state: 'idle',
        lastSuccessAt: this.lastRunAt,
        lastSnapshot: result.latest?.name ?? null,
        lastError: null,
        suspect: result.latest?.suspect?.reasons ?? null,
      })
      if (result.snapshot) this.log.info('backup', reason, '→', result.snapshot, result.latest.suspect ? `(flagged: ${result.latest.suspect.reasons.join(', ')})` : '')
      if (reason !== 'quit') await this.pruneIfDue()
    } catch (err) {
      this.lastRunAt = Date.now()
      this.dirty = mergeDirty(taken, this.dirty)
      if (this.config.folder !== folder) return this.view()
      this.report({ state: 'error', lastError: err.code || CODES.UNKNOWN })
      this.log.warn('backup', reason, 'failed:', err.code || err.message)
    }
    return this.view()
  }

  async pruneIfDue() {
    if (Date.now() - this.lastPruneAt < PRUNE_EVERY_MS) return
    this.lastPruneAt = Date.now()
    try {
      const repo = await openRepo(new FolderTarget(this.config.folder), { wrapKey: backupWrapKey(), expectedRepoId: this.config.repoId })
      const pruned = await pruneRepo(repo)
      if (pruned.snapshots || pruned.objects) this.log.info('backup pruned', pruned.snapshots, 'snapshots,', pruned.objects, 'objects')
    } catch (err) {
      this.log.warn('backup prune failed:', err.code || err.message)
    }
  }

  // A folder inside the app's own data folder would go with the data it is meant to survive.
  configure(folder) {
    if (folder !== null) {
      const dataDir = path.resolve(path.dirname(this.deps.storagePath))
      const chosen = path.resolve(folder)
      if (!path.isAbsolute(folder) || chosen === dataDir || chosen.startsWith(dataDir + path.sep)) {
        throw new AppError(CODES.INVALID_ARGUMENT, 'backup: the folder must be outside the app data folder')
      }
    }
    if (folder !== this.config.folder) {
      this.remember({ folder, repoId: null })
      this.progress = { state: folder ? 'idle' : 'off', ...IDLE }
      if (folder) this.note(URGENCY.URGENT)
    }
    this.report({})
    return this.view()
  }

  remember(config) {
    this.config = config
    this.deps.ipc.emit(MAIN_REQUEST_FRAME, { command: MAIN_REQUEST.BACKUP_REMEMBER, args: config })
  }

  report(patch) {
    this.progress = { ...this.progress, ...patch }
    this.deps.ipc.emit('event:storage-updated', {})
  }

  settingsBytes() {
    let settings
    try {
      settings = JSON.parse(fs.readFileSync(path.join(path.dirname(this.deps.storagePath), CONFIG_FILE), 'utf-8'))
    } catch {
      return null
    }
    const kept = {}
    for (const key of BACKUP_SETTING_GROUPS) if (settings?.[key] !== undefined) kept[key] = settings[key]
    return b4a.from(JSON.stringify(kept))
  }
}
