import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import { setRuntimeConfig, setDownloadFolder } from '../../src/shared/core/runtime-config.js'
import { boot } from '../../src/worker/boot.js'
import { getProfile, getProfileBee, setProfile, markOwnMembership, CAP_MEMBERSHIP_MANIFEST } from '../../src/shared/spaces/profile.js'
import { loadRestoreHold, writeRestoreHold, releaseHeld, isHeld, resetRestoreHold, restoreSource, RESTORE_HOLD_FILE, PROFILE_BEE } from '../../src/shared/core/restore-hold.js'
import { applyPendingIdentityChange, requestSetAside, ADOPT_FILE } from '../../src/shared/core/identity-adopt.js'
import { sealRecoveryKey, ownRecoveryIdentity } from '../../src/shared/core/store.js'
import { FolderTarget } from '../../src/shared/storage/backup/folder-target.js'
import { writeFolderKey } from '../../src/shared/storage/backup/folder-key.js'
import { registerIdentity } from '../../src/worker/ipc/identity.js'
import { registerProfile } from '../../src/worker/ipc/profile.js'
import { createSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { getSpace, mutateSpace } from '../../src/shared/spaces/space.js'
import { waitFor } from '../helpers/bare-poll.js'
import { RESTORE_VERDICT } from '../../src/shared/contract/restore-verdict.js'
import { offlineMemberRegistry } from '../helpers/store.js'
import { createFakeIpc } from '../helpers/fake-ipc.js'
import { tmpDir } from '../helpers/bare-tmp.js'
import { createPassphraseThrottle, buildRecoveryFile, identityPublicKeyHex } from '../../src/shared/core/identity-recovery.js'

const quiet = { debug() {}, info() {}, warn() {}, error() {} }
const KEK = b4a.toString(crypto.randomBytes(32), 'hex')
const PASS = 'a long enough passphrase'
const KEY_AT = '2026-10-01T00:00:00.000Z'

function home(t) {
  const root = tmpDir('restore-hold')
  const storage = path.join(root, 'app-storage')
  fs.mkdirSync(storage, { recursive: true })
  const downloads = tmpDir('restore-hold-dl')
  t.teardown(() => {
    resetRestoreHold()
    for (const dir of [root, downloads]) { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} }
  }, { order: 2 })
  const config = { storage, appVersion: '0.0.0-test', dev: true, verbose: false, downloadFolder: downloads, identityKEK: KEK }
  setRuntimeConfig(config)
  setDownloadFolder(downloads)
  return { root, storage, config }
}

async function bootRoot(t, config, opts = {}) {
  const fake = createFakeIpc()
  const root = await boot(config, { ipc: fake.ipc, log: quiet, swarm: false, memberRegistry: offlineMemberRegistry, ...opts })
  t.teardown(async () => { try { await root.close() } catch {} }, { order: 1 })
  return { root, fake }
}

function backupFolder(t) {
  const dir = tmpDir('restore-hold-backup')
  t.teardown(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} }, { order: 2 })
  return dir
}

async function keepKey(folder, content, identityPub) {
  const target = new FolderTarget(folder)
  await target.ready({ create: true })
  await writeFolderKey(target, { content, createdAt: KEY_AT, identityPub })
}

async function codeOf(promise) {
  try {
    await promise
    return null
  } catch (err) {
    return err.code
  }
}

test('REGRESSION (MIR-30: the first boot after a key was adopted wrote block 0 of the profile)', async (t) => {
  const { storage, config } = home(t)
  await writeRestoreHold(storage, [PROFILE_BEE], 'key')
  const { root } = await bootRoot(t, config, { masterSecret: crypto.randomBytes(32) })

  const core = getProfileBee().core
  t.is(core.length, 0, 'nothing was written to the restored profile at boot')
  t.absent(core.writable, 'the held profile is read-only')
  t.absent(await getProfileBee().get(CAP_MEMBERSHIP_MANIFEST), 'the boot-time caps waited')
  t.is(await getProfile(), null)
  t.is(await codeOf(setProfile({ displayName: 'Too early' })), 'SESSION_NOT_WRITABLE', 'a profile write is refused')
  t.is(core.length, 0)
  t.is(root.restoreCatchUp.status().profile.verdict, RESTORE_VERDICT.NO_HOLDER, 'with nobody connected it waits')
  t.absent(root.restoreCatchUp.status().profile.released)
})

test('a boot with no hold writes the profile as before', async (t) => {
  const { config } = home(t)
  const { root } = await bootRoot(t, config, { masterSecret: crypto.randomBytes(32) })
  t.ok(getProfileBee().core.writable)
  t.ok(await getProfileBee().get(CAP_MEMBERSHIP_MANIFEST), 'the caps are written')
  t.is(root.restoreCatchUp, null, 'no catch-up runs')
})

test('a hold file that cannot be read holds the profile', async (t) => {
  const { root, storage } = home(t)
  fs.writeFileSync(path.join(root, RESTORE_HOLD_FILE), '{ not json')
  await loadRestoreHold(storage)
  t.ok(isHeld(PROFILE_BEE))
})

// REGRESSION (FIX-RESTORE-SOURCE: a backup that brought back no catalog — nothing shared yet — was
// reported as a key restore, because the source was guessed from the held catalogs).
test('the hold says what was restored, whatever it holds, across a partial release', async (t) => {
  const { storage } = home(t)
  await writeRestoreHold(storage, [PROFILE_BEE, 'space-catalog-x-e1'], 'backup')
  await loadRestoreHold(storage)
  await releaseHeld('space-catalog-x-e1')
  await loadRestoreHold(storage)
  t.is(restoreSource(), 'backup', 'a backup that now holds the profile alone is still a backup')
  await writeRestoreHold(storage, [PROFILE_BEE], 'key')
  await loadRestoreHold(storage)
  t.is(restoreSource(), 'key')
})

test('releasing the last held bee removes the hold file', async (t) => {
  const { root, storage } = home(t)
  await writeRestoreHold(storage, [PROFILE_BEE, 'space-catalog-x-e1'], 'backup')
  await loadRestoreHold(storage)
  await releaseHeld(PROFILE_BEE)
  t.ok(isHeld(PROFILE_BEE), 'this process still opened it read-only, so it still reads as held')
  t.alike(JSON.parse(fs.readFileSync(path.join(root, RESTORE_HOLD_FILE), 'utf-8')).held, ['space-catalog-x-e1'])
  await releaseHeld('space-catalog-x-e1')
  t.absent(fs.existsSync(path.join(root, RESTORE_HOLD_FILE)))
})

test('a backup\'s key never unlocks an identity in use', async (t) => {
  const { storage, config } = home(t)
  const { fake } = await bootRoot(t, config, { masterSecret: crypto.randomBytes(32) })
  await setProfile({ displayName: 'In use' })
  registerIdentity(fake.ipc, { storagePath: storage, identityKEK: KEK, log: quiet, lockedBy: null, openRecovery: createPassphraseThrottle() })
  t.is(await codeOf(fake.call('identity:unlock-from-backup', { folder: backupFolder(t), passphrase: PASS })), 'NOT_AUTHORIZED')
})

test('a pending adoption interrupted after the set-aside finishes on the next boot', async (t) => {
  const { root: dataDir, storage } = home(t)
  fs.writeFileSync(path.join(dataDir, ADOPT_FILE), 'adopted envelope')
  await applyPendingIdentityChange(storage)
  t.is(fs.readFileSync(path.join(dataDir, 'identity.enc'), 'utf-8'), 'adopted envelope')
  t.ok(fs.existsSync(path.join(dataDir, RESTORE_HOLD_FILE)))
  t.absent(fs.readdirSync(dataDir).some((n) => n.startsWith('app-storage.locked-')), 'nothing was left to set aside')
  t.is(await applyPendingIdentityChange(storage), null, 'a second run has nothing to do')
})

test('a restore set aside moves the store, the envelope and the hold', async (t) => {
  const { root: dataDir, storage } = home(t)
  fs.writeFileSync(path.join(storage, 'CORESTORE'), 'lock')
  fs.writeFileSync(path.join(dataDir, 'identity.enc'), 'restored')
  await writeRestoreHold(storage, [PROFILE_BEE], 'key')
  requestSetAside(storage)
  const folder = await applyPendingIdentityChange(storage)
  t.ok(folder)
  t.alike(fs.readdirSync(storage), [])
  for (const name of ['CORESTORE', 'identity.enc', RESTORE_HOLD_FILE]) t.ok(fs.existsSync(path.join(folder, name)), name)
  t.absent(fs.existsSync(path.join(dataDir, 'set-aside.pending')))
})

test('the backup\'s key unlocks its own data in place on a locked device: held, and released at once with no co-member', async (t) => {
  const { root: dataDir, storage, config } = home(t)
  const first = await bootRoot(t, config)
  await setProfile({ displayName: 'Alone' })
  const folder = backupFolder(t)
  await keepKey(folder, await sealRecoveryKey(PASS, { createdAt: KEY_AT }), ownRecoveryIdentity())
  await first.root.close()

  const locked = createFakeIpc()
  registerIdentity(locked.ipc, { storagePath: storage, identityKEK: KEK, log: quiet, lockedBy: 'IDENTITY_UNLOCK_FAILED', openRecovery: createPassphraseThrottle() })
  t.is(await codeOf(locked.call('identity:unlock-from-backup', { folder, passphrase: 'not the passphrase' })), 'WRONG_PASSPHRASE')
  t.alike(await locked.call('identity:unlock-from-backup', { folder, passphrase: PASS }), { unlocked: true })
  t.ok(fs.existsSync(path.join(dataDir, RESTORE_HOLD_FILE)), 'held even over its own data, which may be an older copy')

  const { root } = await bootRoot(t, config)
  t.ok(root.restoreCatchUp, 'restore mode')
  t.is((await getProfile())?.displayName, 'Alone', 'the data stayed in place')
  await waitFor(() => root.restoreCatchUp.status().profile.released, 10000, { interval: 200, label: 'release' })
  t.absent(fs.existsSync(path.join(dataDir, RESTORE_HOLD_FILE)), 'nobody else can hold it, so the next boot opens it')
  t.absent(getProfileBee().core.writable, 'this worker keeps it read-only until it restarts')
})

test('another identity\'s backup leaves a locked device\'s data to a restore', async (t) => {
  const { root: dataDir, storage, config } = home(t)
  const first = await bootRoot(t, config)
  await setProfile({ displayName: 'Mine' })
  await first.root.close()
  const other = crypto.randomBytes(32)
  const folder = backupFolder(t)
  await keepKey(folder, await buildRecoveryFile({ master: other }, PASS, { createdAt: KEY_AT }), identityPublicKeyHex(other))

  const locked = createFakeIpc()
  registerIdentity(locked.ipc, { storagePath: storage, identityKEK: KEK, log: quiet, lockedBy: 'IDENTITY_UNLOCK_FAILED', openRecovery: createPassphraseThrottle() })
  t.alike(await locked.call('identity:unlock-from-backup', { folder, passphrase: PASS }), { unlocked: false })
  t.absent(fs.existsSync(path.join(dataDir, RESTORE_HOLD_FILE)), 'nothing adopted')
})

test('a rejoin made while restoring stamps its membership on the first normal boot', async (t) => {
  const { config } = home(t)
  const masterSecret = crypto.randomBytes(32)
  const first = await bootRoot(t, config, { masterSecret })
  await setProfile({ displayName: 'Rejoiner' })
  const { spaceId } = await createSpace('Kept')
  await markOwnMembership(spaceId)
  const before = (await getProfileBee().get('member/' + spaceId)).value.ts
  await mutateSpace(spaceId, (s) => ({ ...s, membershipRefresh: true }))
  await first.root.close()

  await bootRoot(t, config, { masterSecret })
  t.ok((await getProfileBee().get('member/' + spaceId)).value.ts > before, 'a newer record than any tombstone co-members hold')
  t.absent((await getSpace(spaceId)).membershipRefresh, 'and the request is consumed')
})

test('setting up the fresh identity drops a key adoption that never reached a restart', async (t) => {
  const { root: dataDir, storage, config } = home(t)
  const { fake } = await bootRoot(t, config, { masterSecret: crypto.randomBytes(32) })
  registerProfile(fake.ipc, { log: quiet })
  fs.writeFileSync(path.join(dataDir, ADOPT_FILE), 'adopted envelope')
  await fake.call('profile:set', { displayName: 'Kept the new one' })
  t.absent(fs.existsSync(path.join(dataDir, ADOPT_FILE)))
  t.is(await applyPendingIdentityChange(storage), null, 'nothing is set aside on the next boot')
})
