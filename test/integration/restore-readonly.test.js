import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import crypto from 'hypercore-crypto'
import { setRuntimeConfig, setDownloadFolder } from '../../src/shared/core/runtime-config.js'
import { boot } from '../../src/worker/boot.js'
import { setProfile, getProfile, getLocalPublicKeyHex } from '../../src/shared/spaces/profile.js'
import { createSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { getSpace, listSpaces, upsertMember, removeMember } from '../../src/shared/spaces/space.js'
import { catalogNameForSpace } from '../../src/shared/shares/own-catalog.js'
import { writeRestoreHold, PROFILE_BEE } from '../../src/shared/core/restore-hold.js'
import { assertCatalogWritable } from '../../src/shared/core/restore-guard.js'
import { registerProfile } from '../../src/worker/ipc/profile.js'
import { registerSpaces } from '../../src/worker/ipc/spaces.js'
import { registerShares } from '../../src/worker/ipc/shares.js'
import { registerSpaceLeave } from '../../src/worker/ipc/space-leave.js'
import { registerIdentity } from '../../src/worker/ipc/identity.js'
import { createOwnedMounter } from '../../src/worker/owned-mount.js'
import { registerFiles } from '../../src/worker/ipc/files.js'
import { registerOwnedFolders } from '../../src/worker/ipc/owned-folders.js'
import { registerForeignFolders } from '../../src/worker/ipc/foreign-folders.js'
import { createMembership } from '../../src/worker/ipc/membership.js'
import { getOwnedMount } from '../../src/shared/folders/mount-store.js'
import { createPassphraseThrottle } from '../../src/shared/core/identity-recovery.js'
import { offlineMemberRegistry } from '../helpers/store.js'
import { createFakeIpc } from '../helpers/fake-ipc.js'
import { tmpDir } from '../helpers/bare-tmp.js'
import { waitFor } from '../helpers/bare-poll.js'

const quiet = { debug() {}, info() {}, warn() {}, error() {} }
const CAROL = 'c'.repeat(64)

function dirs(t) {
  const home = tmpDir('restore-readonly')
  const storage = path.join(home, 'app-storage')
  fs.mkdirSync(storage, { recursive: true })
  const downloads = tmpDir('restore-readonly-dl')
  t.teardown(() => {
    for (const dir of [home, downloads]) { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} }
  }, { order: 2 })
  return { home, storage, downloads }
}

async function start(t, d, masterSecret) {
  const config = { storage: d.storage, appVersion: 't', dev: true, verbose: false, downloadFolder: d.downloads, restoreReleaseDwellMs: 0 }
  setRuntimeConfig(config)
  setDownloadFolder(d.downloads)
  const fake = createFakeIpc()
  const root = await boot(config, { ipc: fake.ipc, log: quiet, swarm: false, masterSecret, memberRegistry: offlineMemberRegistry })
  t.teardown(async () => { try { await root.close() } catch {} }, { order: 1 })
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

// A device restored from a backup whose one space has a co-member who is away: the profile and the
// space's own catalog are held until Carol confirms them.
async function heldDevice(t, { whileAway = async () => {} } = {}) {
  const d = dirs(t)
  const masterSecret = crypto.randomBytes(32)
  const first = await start(t, d, masterSecret)
  await setProfile({ displayName: 'Original' })
  const { spaceId } = await createSpace('Kept')
  await upsertMember(spaceId, { publicKey: CAROL, displayName: 'Carol' })
  const catalog = catalogNameForSpace(spaceId, await getSpace(spaceId))
  const folder = path.join(d.home, 'Docs')
  fs.mkdirSync(folder, { recursive: true })
  registerShares(first.fake.ipc, { log: quiet, intents: first.root.intents, mountOwnedShare: createOwnedMounter({ ipc: first.fake.ipc, mounts: first.root.mounts }) })
  const { share } = await first.fake.call('share:create-and-mount', { spaceId, name: 'Docs', mountPath: folder })
  await first.root.close()
  await whileAway(folder)

  await writeRestoreHold(d.storage, [PROFILE_BEE, catalog], 'backup')
  const { root, fake } = await start(t, d, masterSecret)
  registerProfile(fake.ipc, { log: quiet })
  registerSpaces(fake.ipc, { log: quiet, publishDownloadRoots: () => {} })
  const mountOwnedShare = createOwnedMounter({ ipc: fake.ipc, mounts: root.mounts })
  registerShares(fake.ipc, { log: quiet, intents: root.intents, mountOwnedShare })
  registerOwnedFolders(fake.ipc, { log: quiet, mounts: root.mounts, intents: root.intents, mountOwnedShare })
  registerForeignFolders(fake.ipc, { log: quiet, intents: root.intents })
  registerFiles(fake.ipc, { log: quiet })
  createMembership(fake.ipc, { log: quiet, dropSpaceDownloadRoot: () => {} })
  registerSpaceLeave(fake.ipc, { log: quiet, mounts: root.mounts, overlayBackend: root.overlayBackend, discardPendingSpace: async () => {}, dropSpaceDownloadRoot: () => {} })
  registerIdentity(fake.ipc, { storagePath: d.storage, identityKEK: null, log: quiet, lockedBy: null, openRecovery: createPassphraseThrottle(), restoreStatus: () => root.restoreCatchUp?.status() ?? null })
  return { root, fake, spaceId, shareId: share.id, folder }
}

test('while a restore is confirmed, every write is refused up front and changes nothing', async (t) => {
  const { fake, spaceId, shareId, folder } = await heldDevice(t)

  t.is(await codeOf(fake.call('profile:set', { displayName: 'Changed', avatar: null })), 'RESTORE_HELD')
  t.is((await getProfile()).displayName, 'Original', 'the profile is untouched')
  t.is(await codeOf(fake.call('space:create', { name: 'Another' })), 'RESTORE_HELD')
  t.is((await listSpaces()).length, 1, 'no space was created')
  t.is(await codeOf(fake.call('share:create', { spaceId, name: 'Folder' })), 'RESTORE_HELD')
  t.is(await codeOf(fake.call('space:invite', { spaceId, expiresInMs: 60000 })), 'RESTORE_HELD')

  t.is(await codeOf(fake.call('space:leave', { spaceId })), 'RESTORE_HELD', 'leaving would release the profile unconfirmed')
  t.ok(await getSpace(spaceId), 'the space is still there')
  t.is(await codeOf(fake.call('space:leave', { spaceId })), 'RESTORE_HELD', 'and a second try is refused the same way, not taken as in flight')

  t.is(await codeOf(fake.call('space:approve-member', { spaceId, publicKey: 'd'.repeat(64) })), 'RESTORE_HELD')
  t.is(await codeOf(fake.call('space:deny-member', { spaceId, publicKey: 'd'.repeat(64) })), 'RESTORE_HELD')
  t.is(await codeOf(fake.call('owned-folder:delete', { spaceId, shareId })), 'RESTORE_HELD')
  t.ok(await getOwnedMount(spaceId, shareId), 'the owned folder is still mounted')
  t.is(await codeOf(fake.call('foreign-folder:unmount', { spaceId, shareId: 'e'.repeat(64) })), 'RESTORE_HELD')
  const file = path.join(folder, 'loose.txt')
  fs.writeFileSync(file, 'loose')
  t.is(await codeOf(fake.call('files:add', { spaceId, filePath: file, fileName: 'loose.txt' })), 'RESTORE_HELD', 'sharing into the held space waits')
  t.ok(Array.isArray(await fake.call('files:list', { spaceId })), 'reading the space works')
  await fake.call('space:update', { spaceId, name: 'Renamed locally' })
  t.is((await getSpace(spaceId)).name, 'Renamed locally', 'what writes nothing replicated still works')
})

test('the restore status says what is held and is pushed as it changes', async (t) => {
  const { root, fake, spaceId } = await heldDevice(t)

  const status = await fake.call('identity:status', {})
  t.is(status.restore.source, 'backup')
  t.is(status.restore.profile.verdict, 'no-holder')
  t.alike(status.restore.heldSpaceIds, [spaceId])

  await removeMember(spaceId, CAROL)
  await waitFor(() => root.restoreCatchUp.status()?.heldSpaceIds.length === 0, 15000, { interval: 200, label: 'the catalog is released once nobody else could hold it' })
  t.ok(fake.emitted('event:restore-updated').length > 0, 'the change was pushed')
  t.is(await codeOf(assertCatalogWritable(spaceId)), null, 'sharing in the space is possible again')
  t.ok(root.restoreCatchUp.status().profile.released, 'the profile is released too')
})

test('a file added while the space was held is published once it is released', async (t) => {
  const { root, fake, spaceId, shareId } = await heldDevice(t, {
    whileAway: async (folder) => fs.writeFileSync(path.join(folder, 'added-while-held.txt'), 'hello'),
  })
  const listed = async () => (await fake.call('share:list-files', { spaceId, ownerKey: getLocalPublicKeyHex(), shareId })).entries.map((entry) => entry.relPath)

  await removeMember(spaceId, CAROL)
  await waitFor(() => root.restoreCatchUp.status()?.heldSpaceIds.length === 0, 15000, { interval: 200, label: 'the catalog is released' })
  await waitFor(async () => (await listed()).some((p) => p.endsWith('added-while-held.txt')), 30000, { interval: 300, label: 'the file is published by the rescan' })
  t.pass('the rescan published what the held catalog could not take')
})
