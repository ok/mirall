import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import { setRuntimeConfig, setDownloadFolder } from '../../src/shared/core/runtime-config.js'
import { boot } from '../../src/worker/boot.js'
import { setProfile } from '../../src/shared/spaces/profile.js'
import { createSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { registerBackup } from '../../src/worker/ipc/backup.js'
import { registerBackupRestore } from '../../src/worker/ipc/backup-restore.js'
import { createPassphraseThrottle, openRecoveryFile } from '../../src/shared/core/identity-recovery.js'
import { REPO_DIR } from '../../src/shared/storage/backup/folder-target.js'
import { KEYS_DIR, writeFolderKey } from '../../src/shared/storage/backup/folder-key.js'
import { FolderTarget } from '../../src/shared/storage/backup/folder-target.js'
import { sealRecoveryKey, ownRecoveryIdentity } from '../../src/shared/core/store.js'
import { BACKUP_STATE_FILE } from '../../src/shared/storage/backup/backup-state.js'
import { offlineMemberRegistry } from '../helpers/store.js'
import { createFakeIpc } from '../helpers/fake-ipc.js'
import { tmpDir } from '../helpers/bare-tmp.js'

const quiet = { debug() {}, info() {}, warn() {}, error() {} }
const PASS = 'a long enough passphrase'
const KEK = b4a.toString(crypto.randomBytes(32), 'hex')

function dirs(t, name) {
  const home = tmpDir(`backup-protect-${name}`)
  const storage = path.join(home, 'app-storage')
  fs.mkdirSync(storage, { recursive: true })
  const downloads = tmpDir(`backup-protect-${name}-dl`)
  t.teardown(() => {
    for (const dir of [home, downloads]) { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} }
  }, { order: 2 })
  return { home, storage, downloads }
}

function backupFolder(t) {
  const dir = tmpDir('backup-protect-target')
  t.teardown(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} }, { order: 3 })
  return dir
}

async function start(t, d, { masterSecret, folder = null, repoId = null, profile = true } = {}) {
  const config = {
    storage: d.storage, appVersion: '0.0.0-test', dev: true, verbose: false, downloadFolder: d.downloads, identityKEK: KEK,
    backupFolder: folder, backupRepoId: repoId,
  }
  setRuntimeConfig(config)
  setDownloadFolder(d.downloads)
  const fake = createFakeIpc()
  const root = await boot(config, { ipc: fake.ipc, log: quiet, swarm: false, masterSecret, memberRegistry: offlineMemberRegistry })
  t.teardown(async () => { try { await root.close() } catch {} }, { order: 1 })
  const openRecovery = createPassphraseThrottle()
  registerBackup(fake.ipc, { backup: root.backup, paused: root.backupPaused, openRecovery })
  registerBackupRestore(fake.ipc, { storagePath: d.storage, identityKEK: KEK, log: quiet, lockedBy: null, openRecovery })
  if (profile) await setProfile({ displayName: 'Protected' })
  return { root, fake }
}

async function codeOf(promise) {
  try {
    await promise
    return null
  } catch (err) {
    return err.code
  }
}

const keyFiles = (folder) => {
  try {
    return fs.readdirSync(path.join(folder, REPO_DIR, KEYS_DIR))
  } catch {
    return []
  }
}
const readKey = (folder) => b4a.toString(fs.readFileSync(path.join(folder, REPO_DIR, KEYS_DIR, keyFiles(folder)[0])))

test('setup writes the folder, the key it can open, and the first backup', async (t) => {
  const d = dirs(t, 'setup')
  const folder = backupFolder(t)
  const { fake } = await start(t, d, { masterSecret: crypto.randomBytes(32) })
  t.is((await fake.call('backup:status', {})).verdict, 'at-risk', 'nothing backed up yet')

  const status = await fake.call('backup:setup', { folder, passphrase: PASS })
  t.is(status.verdict, 'protected')
  t.ok(status.key.reminders)
  t.is(status.folder, folder)
  t.is(status.state, 'idle')
  t.ok(status.lastSuccessAt, 'the first backup ran')
  t.ok(status.key.createdAt)
  t.ok(status.key.inFolder)
  t.ok(status.key.checkedAt, 'the key was opened back with the passphrase')
  t.is(status.prompt, null)
  t.absent(status.stale)
  t.is(keyFiles(folder).length, 1)
  const opened = await openRecoveryFile(readKey(folder), PASS)
  t.ok(opened.masterSecret, 'the key in the folder opens with the passphrase')
})

test('a short passphrase sets nothing up', async (t) => {
  const d = dirs(t, 'short')
  const folder = backupFolder(t)
  const { fake } = await start(t, d, { masterSecret: crypto.randomBytes(32) })
  t.is(await codeOf(fake.call('backup:setup', { folder, passphrase: 'short' })), 'INVALID_ARGUMENT')
  t.is((await fake.call('backup:status', {})).folder, null)
  t.absent(fs.existsSync(path.join(folder, REPO_DIR)))
})

test('the passphrase check and a new passphrase', async (t) => {
  const d = dirs(t, 'keys')
  const folder = backupFolder(t)
  const { fake } = await start(t, d, { masterSecret: crypto.randomBytes(32) })
  const first = await fake.call('backup:setup', { folder, passphrase: PASS })

  t.is(await codeOf(fake.call('backup:check-key', { passphrase: 'not the passphrase at all' })), 'WRONG_PASSPHRASE')
  const checked = await fake.call('backup:check-key', { passphrase: PASS })
  t.ok(checked.key.checkedAt >= first.key.checkedAt)

  const before = keyFiles(folder)[0]
  await fake.call('backup:new-key', { passphrase: 'a different long passphrase' })
  t.is(keyFiles(folder).length, 1, 'the old key is gone from the folder')
  t.not(keyFiles(folder)[0], before)
  t.is(await codeOf(fake.call('backup:check-key', { passphrase: PASS })), 'WRONG_PASSPHRASE')
  t.ok((await fake.call('backup:check-key', { passphrase: 'a different long passphrase' })).key.checkedAt)
})

test('the offer goes to someone with a space, and "Not now" holds across a restart', async (t) => {
  const d = dirs(t, 'offer')
  const masterSecret = crypto.randomBytes(32)
  const first = await start(t, d, { masterSecret })
  t.is((await first.fake.call('backup:status', {})).prompt, null, 'nothing to protect yet')
  await createSpace('Kept')
  t.is((await first.fake.call('backup:status', {})).prompt, 'offer')
  t.is((await first.fake.call('backup:prompt', { prompt: 'offer', action: 'snooze' })).prompt, null)
  t.is(await codeOf(first.fake.call('backup:prompt', { prompt: 'offer', action: 'opt-out' })), 'INVALID_ARGUMENT')
  await first.root.close()

  const again = await start(t, d, { masterSecret, profile: false })
  t.is((await again.fake.call('backup:status', {})).prompt, null, 'the snooze was kept')
  t.ok(fs.existsSync(path.join(d.home, BACKUP_STATE_FILE)))
})

test('the last success and the key survive a restart, and a deleted key is put back', async (t) => {
  const d = dirs(t, 'restart')
  const folder = backupFolder(t)
  const masterSecret = crypto.randomBytes(32)
  const first = await start(t, d, { masterSecret })
  const setUp = await first.fake.call('backup:setup', { folder, passphrase: PASS })
  await first.root.close()

  fs.rmSync(path.join(folder, REPO_DIR, KEYS_DIR), { recursive: true, force: true })
  const again = await start(t, d, { masterSecret, folder, repoId: setUp.repoId, profile: false })
  const status = await again.fake.call('backup:status', {})
  t.is(status.lastSuccessAt, setUp.lastSuccessAt, 'the last backup is still known')
  t.is(status.key.createdAt, setUp.key.createdAt)
  await setProfile({ displayName: 'Changed' })
  const ran = await again.fake.call('backup:run', {})
  t.is(ran.state, 'idle')
  t.is(keyFiles(folder).length, 1, 'the key is back in the folder')
  t.ok(ran.key.inFolder)
})

test('a device with no record takes the folder key of its own identity', async (t) => {
  const d = dirs(t, 'adopt')
  const folder = backupFolder(t)
  const masterSecret = crypto.randomBytes(32)
  const first = await start(t, d, { masterSecret })
  const setUp = await first.fake.call('backup:setup', { folder, passphrase: PASS })
  await first.root.close()

  fs.rmSync(path.join(d.home, BACKUP_STATE_FILE))
  const again = await start(t, d, { masterSecret, folder, repoId: setUp.repoId, profile: false })
  t.is((await again.fake.call('backup:status', {})).key.createdAt, null)
  await setProfile({ displayName: 'Restored' })
  const ran = await again.fake.call('backup:run', {})
  t.is(ran.key.createdAt, setUp.key.createdAt, 'the folder key is this identity\'s, so it is kept')
  t.is(ran.key.checkedAt, null, 'not confirmed on this device yet')
  t.ok((await again.fake.call('backup:check-key', { passphrase: PASS })).key.checkedAt)
})

test('a new device restores from the folder with only the passphrase', async (t) => {
  const folder = backupFolder(t)
  const source = dirs(t, 'source')
  const original = await start(t, source, { masterSecret: crypto.randomBytes(32) })
  const setUp = await original.fake.call('backup:setup', { folder, passphrase: PASS })
  await original.root.close()

  const device = await start(t, dirs(t, 'device'), { masterSecret: crypto.randomBytes(32), profile: false })
  const peek = await device.fake.call('backup:peek', { folder })
  t.ok(peek.backup)
  t.is(peek.keyCreatedAt, setUp.key.createdAt)
  t.ok(peek.lastBackupAt && Math.abs(Date.parse(peek.lastBackupAt) - setUp.lastSuccessAt) < 60000, 'the newest backup time reads without the key')

  t.is(await codeOf(device.fake.call('backup:inspect', { folder, passphrase: 'not the passphrase at all' })), 'WRONG_PASSPHRASE')
  const { snapshots } = await device.fake.call('backup:inspect', { folder, passphrase: PASS })
  t.is(snapshots.length, 1)

  fs.rmSync(path.join(folder, REPO_DIR, KEYS_DIR), { recursive: true, force: true })
  t.is((await device.fake.call('backup:peek', { folder })).keyCreatedAt, null)
  t.is(await codeOf(device.fake.call('backup:inspect', { folder, passphrase: PASS })), 'BACKUP_KEY_MISSING')

  const empty = backupFolder(t)
  t.alike(await device.fake.call('backup:peek', { folder: empty }), { backup: false, keyCreatedAt: null, lastBackupAt: null })
  t.is(await codeOf(device.fake.call('backup:peek', { folder: path.join(empty, 'not-there') })), 'BACKUP_TARGET_OFFLINE')
})

test('a folder that holds another identity\'s backup is refused, and its key is left alone', async (t) => {
  const folder = backupFolder(t)
  const other = await start(t, dirs(t, 'other'), { masterSecret: crypto.randomBytes(32) })
  await other.fake.call('backup:setup', { folder, passphrase: PASS })
  await other.root.close()
  const theirKey = keyFiles(folder)

  const mine = await start(t, dirs(t, 'mine'), { masterSecret: crypto.randomBytes(32) })
  t.is(await codeOf(mine.fake.call('backup:setup', { folder, passphrase: PASS })), 'BACKUP_FOREIGN_IDENTITY')
  t.alike(keyFiles(folder), theirKey, 'the other identity\'s key is still there')
  t.is((await mine.fake.call('backup:status', {})).folder, null, 'and nothing was set up')
})

test('a key kept for another identity is dropped after an identity change', async (t) => {
  const d = dirs(t, 'switch')
  const folder = backupFolder(t)
  const first = await start(t, d, { masterSecret: crypto.randomBytes(32) })
  const setUp = await first.fake.call('backup:setup', { folder, passphrase: PASS })
  await first.root.close()

  const other = await start(t, d, { masterSecret: crypto.randomBytes(32), folder, repoId: setUp.repoId, profile: false })
  const status = await other.fake.call('backup:status', {})
  t.is(status.key.createdAt, null, 'the old identity\'s key is not this one\'s')
  t.is(await codeOf(other.fake.call('backup:check-key', { passphrase: PASS })), 'BACKUP_KEY_MISSING')
})

test('a folder keeping only another identity\'s key is refused, and the key stays', async (t) => {
  const theirs = backupFolder(t)
  const other = await start(t, dirs(t, 'keyonly-other'), { masterSecret: crypto.randomBytes(32) })
  await other.fake.call('backup:setup', { folder: theirs, passphrase: PASS })
  await other.root.close()

  const folder = backupFolder(t)
  fs.mkdirSync(path.join(folder, REPO_DIR, KEYS_DIR), { recursive: true })
  const name = keyFiles(theirs)[0]
  fs.copyFileSync(path.join(theirs, REPO_DIR, KEYS_DIR, name), path.join(folder, REPO_DIR, KEYS_DIR, name))

  const mine = await start(t, dirs(t, 'keyonly-mine'), { masterSecret: crypto.randomBytes(32) })
  t.is(await codeOf(mine.fake.call('backup:setup', { folder, passphrase: PASS })), 'BACKUP_FOREIGN_IDENTITY')
  t.alike(keyFiles(folder), [name])
})

test('a newer key of this identity in the folder is taken, not overwritten', async (t) => {
  const d = dirs(t, 'newer')
  const folder = backupFolder(t)
  const { fake } = await start(t, d, { masterSecret: crypto.randomBytes(32) })
  await fake.call('backup:setup', { folder, passphrase: PASS })

  const createdAt = new Date(Date.now() + 60000).toISOString()
  const content = await sealRecoveryKey('a newer long passphrase', { createdAt })
  await writeFolderKey(new FolderTarget(folder), { content, createdAt, identityPub: ownRecoveryIdentity() })
  await setProfile({ displayName: 'Again' })
  const ran = await fake.call('backup:run', {})
  t.is(ran.key.createdAt, createdAt)
  t.is(keyFiles(folder).length, 1)
  t.ok((await fake.call('backup:check-key', { passphrase: 'a newer long passphrase' })).key.checkedAt)
})

test('a second "Not now" on the same showing counts once', async (t) => {
  const d = dirs(t, 'twice')
  const { fake } = await start(t, d, { masterSecret: crypto.randomBytes(32) })
  await createSpace('Kept')
  await fake.call('backup:prompt', { prompt: 'offer', action: 'snooze' })
  await fake.call('backup:prompt', { prompt: 'offer', action: 'snooze' })
  const state = JSON.parse(fs.readFileSync(path.join(d.home, BACKUP_STATE_FILE), 'utf-8'))
  t.is(state.offer.dismissals, 1)
})

test('the passphrase reminder can be turned off and on, and the verdict follows the key', async (t) => {
  const d = dirs(t, 'reminders')
  const folder = backupFolder(t)
  const masterSecret = crypto.randomBytes(32)
  const first = await start(t, d, { masterSecret })
  const setUp = await first.fake.call('backup:setup', { folder, passphrase: PASS })
  t.absent((await first.fake.call('backup:reminders', { enabled: false })).key.reminders)
  t.ok((await first.fake.call('backup:reminders', { enabled: true })).key.reminders)
  await first.fake.call('backup:reminders', { enabled: false })
  await first.root.close()

  const state = JSON.parse(fs.readFileSync(path.join(d.home, BACKUP_STATE_FILE), 'utf-8'))
  t.ok(state.check.optOut, 'the choice is kept')
  fs.writeFileSync(path.join(d.home, BACKUP_STATE_FILE), JSON.stringify({ ...state, keyContent: null }))
  const again = await start(t, d, { masterSecret, folder, repoId: setUp.repoId, profile: false })
  const status = await again.fake.call('backup:status', {})
  t.absent(status.key.reminders)
  t.is(status.verdict, 'stopped', 'no key kept is a lapse')
})

test('after setup the verdict says why it is at risk: a new folder, then a folder that is gone', async (t) => {
  const d = dirs(t, 'risk')
  const folder = backupFolder(t)
  const { fake } = await start(t, d, { masterSecret: crypto.randomBytes(32) })
  await fake.call('backup:setup', { folder, passphrase: PASS })

  const other = backupFolder(t)
  const moved = await fake.call('backup:configure', { folder: other })
  t.is(moved.verdict, 'at-risk')
  t.is(moved.verdictReason, 'key-not-in-folder')

  fs.rmSync(other, { recursive: true, force: true })
  const failed = await fake.call('backup:run', {})
  t.is(failed.state, 'error')
  t.is(failed.verdictReason, 'failing', 'a failing backup is not shown as protected')
})
