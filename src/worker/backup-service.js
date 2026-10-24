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
import { BACKUP_SETTING_GROUPS } from '../shared/contract/backup-settings.js'
import { backupWrapKey, sealRecoveryKey, ownRecoveryIdentity } from '../shared/core/store.js'
import { assertPassphrase, openRecoveryFile, wipeSecret } from '../shared/core/identity-recovery.js'
import { getAppVersionLabel, getBackupConfig, setBackupConfig, isIdentityWeak } from '../shared/core/runtime-config.js'
import { getSettings, updateSettings } from '../shared/core/settings-store.js'
import { listSpaces } from '../shared/spaces/space.js'
import { FolderTarget, ensureFolderBelow } from '../shared/storage/backup/folder-target.js'
import { getManagedOverlay } from '../shared/core/managed-overlay.js'
import { effectiveBackup } from '../shared/core/managed-effective.js'
import { runBackup } from '../shared/storage/backup/backup-run.js'
import { openRepo, peekRepo } from '../shared/storage/backup/repo.js'
import { pruneRepo } from '../shared/storage/backup/prune.js'
import { initBackupHints, resetBackupHints } from '../shared/storage/backup/backup-hints.js'
import { nextRunAt, URGENCY } from '../shared/storage/backup/schedule-rules.js'
import { loadBackupState, saveBackupState } from '../shared/storage/backup/backup-state.js'
import { writeFolderKey, listFolderKeys } from '../shared/storage/backup/folder-key.js'
import { readRecoveryHeader } from '../shared/contract/recovery-key.js'
import { backupPrompt, protectionVerdict, remindersSet, snoozed, optedOut, turnedOff, folderChosen, keyForgotten, keyAdopted, keyWritten, keyChecked, isStale, PROMPT } from '../shared/storage/backup/prompt-rules.js'

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
    let state = loadBackupState(this.deps.storagePath)
    if (state.keyContent && readRecoveryHeader(state.keyContent)?.identityPub !== ownRecoveryIdentity()) state = keyForgotten(state)
    if (getBackupConfig().folder && state.setupAt === null && !this.managedFolder()) state = folderChosen(state, Date.now())
    this.state = this.withManagedRecord(state)
    if (this.state.managed !== state.managed) await saveBackupState(this.deps.storagePath, this.state)
    this.config = this.effectiveConfig(this.state)
    // Key writes and a run's key upkeep take turns, so neither undoes the other.
    this.keys = Promise.resolve()
    this.dirty = null
    this.lastRunAt = null
    // Failed runs in a row against the current folder; they space out the next scheduled run.
    this.failures = 0
    this.lastPruneAt = 0
    this.running = null
    this.cutoffAt = null
    this.wake = null
    this.progress = { state: this.isSetUp() ? 'idle' : 'off', ...IDLE, lastSuccessAt: this.state.lastSuccessAt }
    // What removals through the leave and join flows explained in the latest snapshot, for diagnostics.
    this.explained = null
    initBackupHints((urgency) => this.note(urgency))
    // A device that keeps no key — a restored one — takes its folder's key now rather than at its first
    // run, so the verdict never asks for a passphrase the folder already holds.
    if (this.isSetUp() && !this.state.keyContent) this.timers.setTimeout(() => void this.adoptFolderKey(this.config.folder), 0)
    this.timers.setTimeout(() => this.runSoon('boot'), this.deps.bootDelayMs ?? BOOT_RUN_DELAY_MS)
    this.timers.setInterval(() => this.runSoon('interval'), this.deps.intervalMs ?? INTERVAL_MS)
  }

  async _close() {
    resetBackupHints()
    this.cutoffAt = Date.now() + QUIT_CUTOFF_MS
    const flush = this.running ?? (this.dirty && this.isSetUp() ? this.attempt('quit') : null)
    if (!flush) return
    let timer = null
    const waited = new Promise((resolve) => { timer = this.timers.setTimeout(resolve, QUIT_CUTOFF_MS + 200) })
    await Promise.race([flush, waited])
    this.timers.clear(timer)
  }

  // An organization's folder, resolved for this device, wins over the person's own; it counts as set
  // up only once the person chose a passphrase for it.
  managedFolder() {
    return getManagedOverlay()?.backup ?? null
  }

  required() {
    return effectiveBackup(getBackupConfig(), getManagedOverlay()).required
  }

  effectiveConfig(state) {
    const managed = this.managedFolder()
    if (!managed) return getBackupConfig()
    return { folder: managed.folder, repoId: state.managed?.folder === managed.folder ? state.managed.repoId : null }
  }

  // The managed repository's id is kept here, never in settings.json, so the person's own folder and
  // repository come back unchanged when the organization's folder goes.
  withManagedRecord(state) {
    const managed = this.managedFolder()
    if (!managed) return state.managed ? { ...state, managed: null } : state
    return state.managed?.folder === managed.folder ? state : { ...state, managed: { folder: managed.folder, repoId: null, setupAt: null } }
  }

  // An organization's folder is set up only by a setup there: the person's own setupAt, or an earlier
  // organization folder's, says nothing about a folder that may not exist yet.
  isSetUp() {
    if (this.config.folder === null) return false
    return !this.managedFolder() || (this.state.managed?.setupAt ?? null) !== null
  }

  setupTime() {
    return this.managedFolder() ? this.state.managed?.setupAt ?? null : this.state.setupAt
  }

  // The organization's configuration changed: its folder came, moved or went. A run in progress
  // finishes against the folder it started with.
  async reconsider() {
    try {
      if (this.running) await this.running.catch(() => {})
      if (this.stopping) return
      const state = this.withManagedRecord(this.state)
      if (state !== this.state) await this.persist(state)
      const next = this.effectiveConfig(this.state)
      if (next.folder !== this.config.folder || next.repoId !== this.config.repoId) {
        this.config = next
        this.progress = { state: this.isSetUp() ? 'idle' : 'off', ...IDLE }
        this.failures = 0
        this.explained = null
        if (this.isSetUp()) {
          this.state = { ...this.state, keyInFolder: false }
          this.note(URGENCY.URGENT)
        } else this.schedule()
      }
      this.report({})
    } catch (err) {
      this.log.warn('backup: the organization\'s folder could not be applied:', err.message)
    }
  }

  view() {
    return { folder: this.isSetUp() ? this.config.folder : null, repoId: this.config.repoId, ...this.progress }
  }

  verdictNow(now) {
    const setUp = this.isSetUp()
    const stale = isStale({ now, setUp, lastSuccessAt: this.state.lastSuccessAt, setupAt: this.setupTime() })
    return { setUp, stale, ...protectionVerdict({ setUp, stale, ...this.failure(), state: this.state, required: this.required() }) }
  }

  // A failure holds until a run succeeds or the folder changes, through the retries in between: the
  // verdict does not flip back while a retry runs.
  failure() {
    const { lastError } = this.progress
    return { failing: lastError !== null, offline: lastError === CODES.BACKUP_TARGET_OFFLINE }
  }

  protection() {
    const { setUp, verdict } = this.verdictNow(Date.now())
    return { setUp, verdict, lastSuccessAt: this.state.lastSuccessAt ?? null, managedFolder: this.managedFolder() !== null }
  }

  lossCheck() {
    return { suspect: this.progress.suspect, explained: this.explained }
  }

  async status() {
    const now = Date.now()
    const { keyCreatedAt, keyInFolder, keyCheckedAt, check } = this.state
    const { stale, verdict, reason } = this.verdictNow(now)
    return {
      ...this.view(),
      key: { createdAt: keyCreatedAt, inFolder: keyInFolder, checkedAt: keyCheckedAt, reminders: !check.optOut },
      prompt: await this.duePrompt(now),
      stale,
      verdict,
      verdictReason: reason,
    }
  }

  async duePrompt(now) {
    const eligible = isIdentityWeak() || (await listSpaces()).length > 0
    return backupPrompt({ now, setUp: this.isSetUp(), eligible, state: this.state, required: this.required() })
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
    if (this.stopping || !this.isSetUp()) return
    const at = nextRunAt({
      firstDirtyAt: this.dirty?.firstAt ?? null,
      lastEventAt: this.dirty?.lastAt ?? 0,
      urgency: this.dirty?.urgency ?? URGENCY.NORMAL,
      lastRunAt: this.lastRunAt,
      failures: this.failures,
      now: Date.now(),
    })
    if (at !== null) this.wake = this.timers.setTimeout(() => this.runSoon('change'), at - Date.now())
  }

  runSoon(reason) {
    this.run(reason).catch((err) => this.log.warn('backup run failed:', err.message))
  }

  async run(reason) {
    if (!this.stopping && this.isSetUp()) await (this.running ?? this.attempt(reason))
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
      if (!this.stillNames(folder)) return
      this.failures = 0
      if (result.repoId !== repoId) await this.remember({ folder, repoId: result.repoId })
      await this.keepKeyInFolder(folder)
      await this.persist({ ...this.state, lastSuccessAt: this.lastRunAt })
      this.report({
        state: 'idle',
        lastSuccessAt: this.lastRunAt,
        lastSnapshot: result.latest?.name ?? null,
        lastError: null,
        suspect: result.latest?.suspect?.reasons ?? null,
      })
      this.explained = result.latest?.explained ?? null
      if (result.snapshot) this.log.info('backup', reason, '→', result.snapshot, result.latest.suspect ? `(flagged: ${result.latest.suspect.reasons.join(', ')})` : '', result.latest.explained ? `(explained: ${JSON.stringify(result.latest.explained)})` : '')
      if (reason !== 'quit') await this.pruneIfDue()
    } catch (err) {
      this.lastRunAt = Date.now()
      this.dirty = mergeDirty(taken, this.dirty)
      if (!this.stillNames(folder)) return
      this.failures += 1
      this.report({ state: 'error', lastError: err.code || CODES.UNKNOWN })
      this.log.warn('backup', reason, 'failed:', err.code || err.message)
    }
  }

  // A run's outcome is recorded only while its folder is still the one in force. The organization's
  // folder can go mid-run, before reconsider() catches config up, and recording then would make it
  // the person's own.
  stillNames(folder) {
    return this.config.folder === folder && this.effectiveConfig(this.state).folder === folder
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

  async adoptFolderKey(folder) {
    await this.keepKeyInFolder(folder)
    try {
      await this.persist(this.state)
    } catch (err) {
      this.log.warn('backup: the adopted key could not be recorded:', err.code || err.message)
    }
    this.report({})
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
    const managed = this.managedFolder()
    if (managed) await ensureFolderBelow(managed.base, managed.folder)
    const target = new FolderTarget(folder)
    await target.ready({ create: true })
    await this.writeKey(target, passphrase)
    const now = Date.now()
    const chosen = folderChosen(this.state, now)
    await this.persist(managed ? { ...chosen, managed: { repoId: null, ...this.state.managed, folder, setupAt: now } } : chosen)
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

  // Through the shared throttle, like every other open of a sealed key.
  async checkKey(passphrase, open) {
    const { keyContent } = this.state
    if (!keyContent) throw new AppError(CODES.BACKUP_KEY_MISSING, 'backup: no recovery key is kept')
    const opened = await open(keyContent, passphrase)
    wipeSecret(opened.masterSecret)
    await this.persist(keyChecked(this.state, Date.now()))
    this.report({})
    return this.status()
  }

  async setReminders(on) {
    await this.persist(remindersSet(this.state, on, Date.now()))
    this.report({})
    return this.status()
  }

  async answerPrompt(prompt, action) {
    const known = (prompt === PROMPT.OFFER && action === 'snooze') || (prompt === PROMPT.CHECK && (action === 'snooze' || action === 'opt-out'))
    if (!known) throw new AppError(CODES.INVALID_ARGUMENT, `backup: no ${action} for the ${prompt} prompt`)
    if (prompt === PROMPT.OFFER && this.required()) throw new AppError(CODES.MANAGED_LOCKED, 'backup: a backup is required by your organization')
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
    if (this.managedFolder()) {
      if (folder === null) {
        const off = turnedOff(this.state)
        await this.persist({ ...off, managed: this.state.managed && { ...this.state.managed, setupAt: null } })
        this.progress = { state: 'off', ...IDLE }
        this.failures = 0
        this.schedule()
      }
      this.report({})
      return this.status()
    }
    if (folder !== null) this.assertFolder(folder)
    if (folder !== this.config.folder) {
      if (folder !== null) await new FolderTarget(folder).check()
      await this.remember({ folder, repoId: null })
      this.progress = { state: folder ? 'idle' : 'off', ...IDLE }
      this.failures = 0
      this.explained = null
      if (folder) this.note(URGENCY.URGENT)
      await this.persist(folder ? { ...folderChosen(this.state, Date.now()), keyInFolder: false } : turnedOff(this.state))
    }
    this.report({})
    return this.status()
  }

  async remember(config) {
    if (this.managedFolder()) {
      await this.persist({ ...this.state, managed: { setupAt: null, ...this.state.managed, folder: config.folder, repoId: config.repoId } })
      this.config = config
      return
    }
    await updateSettings((s) => { s.backup = { folder: config.folder, repoId: config.repoId }; return s })
    this.config = config
    setBackupConfig(config)
  }

  report(patch) {
    this.progress = { ...this.progress, ...patch }
    this.deps.ipc.emit('event:storage-updated', {})
  }

  // The groups that follow the user: main's config.json holds appearance and notifications, the
  // worker's own settings hold downloads and network.
  settingsBytes() {
    let hostSettings
    try {
      hostSettings = JSON.parse(fs.readFileSync(path.join(path.dirname(this.deps.storagePath), CONFIG_FILE), 'utf-8'))
    } catch {
      hostSettings = {}
    }
    const own = getSettings()
    const kept = {}
    for (const key of BACKUP_SETTING_GROUPS) {
      const value = key in own ? own[key] : hostSettings?.[key]
      if (value !== undefined) kept[key] = value
    }
    return b4a.from(JSON.stringify(kept))
  }
}
