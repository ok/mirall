// The local backup, kept running: a run soon after boot, one an hour, and one shortly after any change
// worth backing up (schedule-rules.js), never two at once. A run is skipped while no folder is set.
// A run takes the changes noted so far; changes that land while it runs wait for the next one, and a
// run that fails hands its changes back. On quit, a run in progress or a due one gets a short cutoff
// and is waited for no longer than that: one that runs out of time writes nothing, and the next start
// runs. The folder and the repository it holds are main's to keep: a new repository id is sent there.
//
// The recovery key lives in the backup folder too, so the folder and its passphrase are all a restore
// needs. This device keeps the same sealed file and puts it back into the folder whenever a run finds it
// missing (a new folder, a deleted file); a restored device takes the folder's key as its own.
import fs from 'bare-fs'
import b4a from 'b4a'
import path from 'bare-path'
import { Subsystem } from '../shared/core/subsystem.js'
import { AppError } from '../shared/core/errors.js'
import { CODES } from '../shared/contract/errors.js'
import { MAIN_REQUEST_FRAME, MAIN_REQUEST } from '../shared/contract/main-requests.js'
import { BACKUP_SETTING_GROUPS } from '../shared/contract/backup-settings.js'
import { backupWrapKey, sealRecoveryKey, ownRecoveryIdentity } from '../shared/core/store.js'
import { assertPassphrase, openRecoveryFile, wipeSecret } from '../shared/core/identity-recovery.js'
import { getAppVersionLabel, getBackupConfig, isIdentityWeak } from '../shared/core/runtime-config.js'
import { listSpaces } from '../shared/spaces/space.js'
import { FolderTarget } from '../shared/storage/backup/folder-target.js'
import { runBackup } from '../shared/storage/backup/backup-run.js'
import { openRepo, peekRepo } from '../shared/storage/backup/repo.js'
import { pruneRepo } from '../shared/storage/backup/prune.js'
import { initBackupHints, resetBackupHints } from '../shared/storage/backup/backup-hints.js'
import { nextRunAt, URGENCY } from '../shared/storage/backup/schedule-rules.js'
import { loadBackupState, saveBackupState } from '../shared/storage/backup/backup-state.js'
import { writeFolderKey, listFolderKeys } from '../shared/storage/backup/folder-key.js'
import { readRecoveryHeader } from '../shared/contract/recovery-key.js'
import { backupPrompt, snoozed, optedOut, turnedOff, folderChosen, keyForgotten, keyAdopted, keyWritten, keyChecked, isStale, PROMPT } from '../shared/storage/backup/prompt-rules.js'

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
    let state = loadBackupState(this.deps.storagePath)
    if (state.keyContent && readRecoveryHeader(state.keyContent)?.identityPub !== ownRecoveryIdentity()) state = keyForgotten(state)
    if (this.config.folder && state.setupAt === null) state = folderChosen(state, Date.now())
    this.state = state
    // Key writes and a run's key upkeep take turns, so neither undoes the other.
    this.keys = Promise.resolve()
    this.dirty = null
    this.lastRunAt = null
    this.lastPruneAt = 0
    this.running = null
    this.cutoffAt = null
    this.wake = null
    this.progress = { state: this.config.folder ? 'idle' : 'off', ...IDLE, lastSuccessAt: this.state.lastSuccessAt }
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

  async status() {
    const now = Date.now()
    const setUp = this.config.folder !== null
    const { keyCreatedAt, keyInFolder, keyCheckedAt, secondCopyAt, lastSuccessAt, setupAt } = this.state
    return {
      ...this.view(),
      key: { createdAt: keyCreatedAt, inFolder: keyInFolder, checkedAt: keyCheckedAt, secondCopyAt },
      prompt: await this.duePrompt(now),
      stale: isStale({ now, setUp, lastSuccessAt, setupAt }),
    }
  }

  async duePrompt(now) {
    const eligible = isIdentityWeak() || (await listSpaces()).length > 0
    return backupPrompt({ now, setUp: this.config.folder !== null, eligible, state: this.state })
  }

  withKeys(fn) {
    const turn = this.keys.then(fn)
    this.keys = turn.catch(() => {})
    return turn
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

  async run(reason) {
    if (!this.stopping && this.config.folder) await (this.running ?? this.attempt(reason))
    return this.status()
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
      if (this.config.folder !== folder) return
      if (result.repoId !== repoId) this.remember({ folder, repoId: result.repoId })
      await this.keepKeyInFolder(folder)
      await this.persist({ ...this.state, lastSuccessAt: this.lastRunAt })
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
      if (this.config.folder !== folder) return
      this.report({ state: 'error', lastError: err.code || CODES.UNKNOWN })
      this.log.warn('backup', reason, 'failed:', err.code || err.message)
    }
  }

  // The key this device keeps goes back into the folder when the folder lacks it. A newer key of this
  // identity in the folder, or one on a device that keeps none (a restored one), is taken instead of
  // overwritten. Another identity's key is never replaced.
  async keepKeyInFolder(folder) {
    try {
      await this.withKeys(() => this.syncFolderKey(new FolderTarget(folder)))
    } catch (err) {
      this.state = { ...this.state, keyInFolder: false }
      this.log.warn('backup: the recovery key could not be kept in the folder:', err.code || err.message)
    }
  }

  async syncFolderKey(target) {
    const own = ownRecoveryIdentity()
    const keys = await listFolderKeys(target)
    const newest = keys.find((key) => key.identityPub === own) ?? null
    const { keyContent, keyCreatedAt } = this.state
    if (newest && (!keyContent || (keyCreatedAt !== null && newest.createdAt > keyCreatedAt))) {
      this.state = keyAdopted(this.state, Date.now(), newest)
    } else if (keyContent && keyCreatedAt && newest?.createdAt !== keyCreatedAt) {
      if (keys.some((key) => key.identityPub !== own)) throw new AppError(CODES.BACKUP_FOREIGN_IDENTITY, 'backup: the folder keeps another identity\'s key')
      await writeFolderKey(target, { content: keyContent, createdAt: keyCreatedAt, identityPub: own })
    }
    this.state = { ...this.state, keyInFolder: this.state.keyContent !== null }
  }

  // Set up in one go: the folder, then the recovery key sealed under the passphrase, written into the
  // folder and opened back from there with the same passphrase, then the first backup.
  async setUp(folder, passphrase) {
    assertPassphrase(passphrase)
    this.assertFolder(folder)
    const target = new FolderTarget(folder)
    await target.ready({ create: true })
    await this.writeKey(target, passphrase)
    await this.persist(folderChosen(this.state, Date.now()))
    await this.configure(folder)
    return this.run('setup')
  }

  async newKey(passphrase) {
    assertPassphrase(passphrase)
    if (!this.config.folder) throw new AppError(CODES.NOT_FOUND, 'backup: no folder is set up')
    const target = new FolderTarget(this.config.folder)
    await target.ready()
    await this.writeKey(target, passphrase)
    this.report({})
    return this.status()
  }

  // A folder that already holds a backup, or a key, must be this identity's: a key written there would
  // sit beside another identity's backup.
  writeKey(target, passphrase) {
    return this.withKeys(async () => {
      const own = ownRecoveryIdentity()
      if ((await peekRepo(target)).backup) await openRepo(target, { wrapKey: backupWrapKey() })
      if ((await listFolderKeys(target)).some((key) => key.identityPub !== own)) {
        throw new AppError(CODES.BACKUP_FOREIGN_IDENTITY, 'backup: the folder keeps another identity\'s key')
      }
      const createdAt = new Date().toISOString()
      const content = await sealRecoveryKey(passphrase, { createdAt })
      await writeFolderKey(target, { content, createdAt, identityPub: own })
      const back = (await listFolderKeys(target)).find((key) => key.createdAt === createdAt && key.identityPub === own)
      if (!back) throw new AppError(CODES.BACKUP_KEY_MISSING, 'backup: the recovery key did not land in the folder')
      const opened = await openRecoveryFile(back.content, passphrase)
      wipeSecret(opened.masterSecret)
      await this.persist(keyWritten(this.state, Date.now(), { content, createdAt }))
    })
  }

  // Through the shared throttle, like every other recovery-file open.
  async checkKey(passphrase, open) {
    const { keyContent } = this.state
    if (!keyContent) throw new AppError(CODES.BACKUP_KEY_MISSING, 'backup: no recovery key is kept')
    const opened = await open(keyContent, passphrase)
    wipeSecret(opened.masterSecret)
    await this.persist(keyChecked(this.state, Date.now()))
    this.report({})
    return this.status()
  }

  keyFile() {
    const { keyContent, keyCreatedAt } = this.state
    if (!keyContent || !keyCreatedAt) throw new AppError(CODES.BACKUP_KEY_MISSING, 'backup: no recovery key is kept')
    return { fileName: `mirall-recovery-${keyCreatedAt.slice(0, 10)}.mirallkey`, content: keyContent }
  }

  async keyCopied() {
    await this.persist({ ...this.state, secondCopyAt: Date.now() })
    this.report({})
    return this.status()
  }

  async answerPrompt(prompt, action) {
    const known = (prompt === PROMPT.OFFER && action === 'snooze') || (prompt === PROMPT.CHECK && (action === 'snooze' || action === 'opt-out'))
    if (!known) throw new AppError(CODES.INVALID_ARGUMENT, `backup: no ${action} for the ${prompt} prompt`)
    const now = Date.now()
    // A snooze counts only for a prompt that is showing: a second click must not spend a second one.
    if (action === 'opt-out') await this.persist(optedOut(this.state))
    else if ((await this.duePrompt(now)) === prompt) await this.persist(snoozed(this.state, prompt, now))
    this.report({})
    return this.status()
  }

  async persist(state) {
    this.state = state
    await saveBackupState(this.deps.storagePath, state)
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
  assertFolder(folder) {
    const dataDir = path.resolve(path.dirname(this.deps.storagePath))
    const chosen = path.resolve(folder)
    if (!path.isAbsolute(folder) || chosen === dataDir || chosen.startsWith(dataDir + path.sep)) {
      throw new AppError(CODES.INVALID_ARGUMENT, 'backup: the folder must be outside the app data folder')
    }
  }

  async configure(folder) {
    if (folder !== null) this.assertFolder(folder)
    if (folder !== this.config.folder) {
      this.remember({ folder, repoId: null })
      this.progress = { state: folder ? 'idle' : 'off', ...IDLE }
      if (folder) this.note(URGENCY.URGENT)
      await this.persist(folder ? { ...folderChosen(this.state, Date.now()), keyInFolder: false } : turnedOff(this.state))
    }
    this.report({})
    return this.status()
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
