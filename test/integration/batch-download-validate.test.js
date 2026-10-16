import test from 'brittle'
import b4a from 'b4a'
import { setupOwnedShare } from '../helpers/owned.js'
import { createOwnedMounter } from '../../src/worker/owned-mount.js'
import { registerShares } from '../../src/worker/ipc/shares.js'
import { createForeignMount } from '../../src/shared/folders/mount-store.js'
import { validateArgs } from '../../src/shared/core/handler-table.js'
import { REQUESTS } from '../../src/shared/contract/requests.js'
import { BATCH_MAX_ITEMS } from '../../src/shared/contract/limits.js'
import { requestShareDownloads } from '../../src/shared/transfer/overlay/share-downloads.js'
import { registerFiles } from '../../src/worker/ipc/files.js'
import { upsertMember, getSpace } from '../../src/shared/spaces/space.js'
import { generateShareId } from '../../src/shared/shares/shares.js'
import { createBee } from '../../src/shared/core/store.js'
import { getDownloadDir } from '../../src/shared/core/paths.js'
import { getSettings } from '../../src/shared/core/settings-store.js'
import { listPending } from '../../src/shared/transfer/pending-transfers.js'
import fs from 'bare-fs'
import path from 'bare-path'
import { createFolderChooser } from '../../src/worker/download-folder-push.js'

// What a batch request refuses before it touches a catalog: a path that escapes, a folder name
// that would escape, an own folder, a mirrored folder, and a list past the boundary cap. A folder
// any download names becomes the space's only once the backend has accepted the request.

const quiet = { debug() {}, info() {}, warn() {}, error() {} }

async function withHandlers(t) {
  const ctx = await setupOwnedShare(t, { name: 'Vault', files: { 'a.txt': 'x' } })
  const mountOwnedShare = createOwnedMounter({ ipc: ctx.fake.ipc, mounts: ctx.root.mounts })
  const chooseFolder = createFolderChooser({ ipc: ctx.fake.ipc, publishRevealRoots: () => {} })
  registerShares(ctx.fake.ipc, { log: quiet, intents: ctx.root.intents, mountOwnedShare, chooseFolder })
  registerFiles(ctx.fake.ipc, { log: quiet, chooseFolder })
  return ctx
}

async function refusal(fn) {
  try { await fn() } catch (err) { return err.code ?? err.message }
  return null
}

test('a list past the cap, an empty list and an over-long item are refused by the validator', (t) => {
  const args = REQUESTS['share:read-files'].args
  const base = { ownerKey: 'o', shareId: 's', spaceId: 'sp' }
  t.ok(/exceeds/.test(validateArgs(args, { ...base, relPaths: Array.from({ length: BATCH_MAX_ITEMS + 1 }, (_, i) => 'f' + i) }) ?? ''), 'one over the cap')
  t.is(validateArgs(args, { ...base, relPaths: Array.from({ length: BATCH_MAX_ITEMS }, (_, i) => 'f' + i) }), null, 'the cap itself passes')
  t.ok(/at least/.test(validateArgs(args, { ...base, relPaths: [] }) ?? ''), 'an empty batch')
  const loose = REQUESTS['files:download-many'].args
  t.ok(/at least/.test(validateArgs(loose, { ownerKey: 'o', spaceId: 'sp', paths: [] }) ?? ''))
})

test('an own folder is refused by the handler', async (t) => {
  const ctx = await withHandlers(t)
  t.is(await refusal(() => ctx.fake.call('share:read-files', { spaceId: ctx.spaceId, ownerKey: ctx.share.owner, shareId: ctx.share.id, relPaths: ['a.txt'] })), 'INVALID_ARGUMENT')
})

// What a refused request must leave as it was: the space's folder, on its record and live, the
// recent folders, and every pending row.
async function folderState(ctx) {
  return {
    record: (await getSpace(ctx.spaceId)).downloadFolder,
    live: getDownloadDir(ctx.spaceId),
    recent: getSettings().downloads.recent,
    rows: (await listPending()).length,
  }
}

test('an own folder named with a download folder is refused and changes no folder', async (t) => {
  const ctx = await withHandlers(t)
  const before = await folderState(ctx)
  const destDir = ctx.tmpDir('dl-asked')
  t.is(await refusal(() => ctx.fake.call('share:read-files', { spaceId: ctx.spaceId, ownerKey: ctx.share.owner, shareId: ctx.share.id, relPaths: ['a.txt'], destDir })), 'INVALID_ARGUMENT')
  t.alike(await folderState(ctx), before)
})

test('a download folder inside an owned folder refuses the batch before any file and changes no folder', async (t) => {
  const ctx = await withHandlers(t)
  const owner = 'peer'.padEnd(64, '0')
  await upsertMember(ctx.spaceId, { publicKey: owner }, { verified: true })
  const inside = path.join(ctx.mountPath, 'downloads')
  fs.mkdirSync(inside, { recursive: true })
  const before = await folderState(ctx)
  t.is(await refusal(() => ctx.fake.call('files:download-many', { spaceId: ctx.spaceId, ownerKey: owner, paths: ['/a.bin', '/b.bin'], destDir: inside })), 'DOWNLOAD_FOLDER_OVERLAPS_MOUNT')
  t.is(await refusal(() => ctx.fake.call('files:download', { spaceId: ctx.spaceId, ownerKey: owner, path: '/a.bin', destDir: inside })), 'DOWNLOAD_FOLDER_OVERLAPS_MOUNT', 'a single file too')
  t.alike(await folderState(ctx), before)
})

// A member's folder share as this device reads it: the member's profile bee in the local store,
// holding the share record, and the member on the space's roster.
async function stagePeerShare(spaceId, { name = 'Press' } = {}) {
  const bee = createBee('peer-profile-' + generateShareId())
  await bee.ready()
  const ownerKey = b4a.toString(bee.core.key, 'hex')
  const share = { id: generateShareId(), type: 'owned-folder', name, owner: ownerKey, contentMode: 'overlay', catalogKey: 'cd'.repeat(32), createdAt: Date.now() }
  await bee.put('caps/folder-shares', true)
  await bee.put('share/' + spaceId + '/' + share.id, share)
  await bee.close()
  await upsertMember(spaceId, { publicKey: ownerKey }, { verified: true })
  return { ownerKey, shareId: share.id }
}

// The volume's free-space answer is the one stand-in: 1 MiB is below the headroom any batch keeps.
function fullDisk(t, ctx) {
  const engine = ctx.root.overlayBackend.engine
  const realProbe = engine.destProbe
  engine.destProbe = (dir) => ({ ...realProbe(dir), freeBytes: () => 1024 * 1024 })
  t.teardown(() => { engine.destProbe = realProbe })
}

const statePushes = (ctx) => ctx.fake.emitted('event:state').length

test('REGRESSION (FIX-DLTO-R4: a refused batch moved the space\'s folder): a path that escapes moves no folder', async (t) => {
  const ctx = await withHandlers(t)
  const owner = 'peer'.padEnd(64, '0')
  await upsertMember(ctx.spaceId, { publicKey: owner }, { verified: true })
  const before = await folderState(ctx)
  const destDir = ctx.tmpDir('dl-asked')
  t.is(await refusal(() => ctx.fake.call('files:download-many', { spaceId: ctx.spaceId, ownerKey: owner, paths: ['/ok.bin', '/../x'], destDir })), 'EPATH')
  t.alike(await folderState(ctx), before)
  t.is(statePushes(ctx), 0, 'and no move is announced')
})

test('REGRESSION (FIX-DLTO-R4: a refused batch moved the space\'s folder): a folder too full for the batch moves no folder', async (t) => {
  const ctx = await withHandlers(t)
  const peer = await stagePeerShare(ctx.spaceId)
  fullDisk(t, ctx)
  const before = await folderState(ctx)
  const destDir = ctx.tmpDir('dl-small')
  t.is(await refusal(() => ctx.fake.call('share:read-files', { spaceId: ctx.spaceId, ...peer, relPaths: ['big.bin'], destDir })), 'TRANSFER_DISK_FULL')
  t.alike(await folderState(ctx), before)
  t.is(statePushes(ctx), 0, 'and no move is announced')
})

test('a download the backend accepts moves the space to the folder it names, and says so', async (t) => {
  const ctx = await withHandlers(t)
  const owner = 'peer'.padEnd(64, '0')
  await upsertMember(ctx.spaceId, { publicKey: owner }, { verified: true })
  const peer = await stagePeerShare(ctx.spaceId)
  const calls = [
    ['files:download-many', { ownerKey: owner, paths: ['/a.bin'] }],
    ['files:download', { ownerKey: owner, path: '/b.bin' }],
    ['share:read-files', { ...peer, relPaths: ['c.bin'] }],
    ['share:read-file', { ...peer, relPath: 'd.bin' }],
  ]
  for (const [name, args] of calls) {
    const destDir = ctx.tmpDir('dl-' + name.replace(':', '-'))
    const moved = await ctx.fake.call(name, { spaceId: ctx.spaceId, ...args, destDir })
    t.is(moved.folderChanged, true, name + ' names a new folder')
    t.is((await getSpace(ctx.spaceId)).downloadFolder, destDir)
    const again = await ctx.fake.call(name, { spaceId: ctx.spaceId, ...args, destDir })
    t.absent('folderChanged' in again, name + ' naming the current folder moves nothing')
  }
})

test('a mirrored folder answers mirrored and moves no folder', async (t) => {
  const ctx = await withHandlers(t)
  const peer = await stagePeerShare(ctx.spaceId)
  await createForeignMount({ spaceId: ctx.spaceId, shareId: peer.shareId, ownerKey: peer.ownerKey, mountPath: ctx.tmpDir('mirror'), enabled: true, status: 'active', attachedAt: Date.now(), syncedPaths: [] })
  const before = await folderState(ctx)
  const destDir = ctx.tmpDir('dl-asked')
  t.alike(await ctx.fake.call('share:read-files', { spaceId: ctx.spaceId, ...peer, relPaths: ['a.txt'], destDir }), { mirrored: true })
  t.alike(await ctx.fake.call('share:read-file', { spaceId: ctx.spaceId, ...peer, relPath: 'a.txt', destDir }), { ok: true, mirrored: true })
  t.alike(await folderState(ctx), before)
  t.is(statePushes(ctx), 0)
})

test('a path that escapes refuses the whole batch', async (t) => {
  const ctx = await setupOwnedShare(t, { name: 'Vault' })
  const share = { ...ctx.share, owner: 'peer'.padEnd(64, '0') }
  t.is(await refusal(() => requestShareDownloads(ctx.spaceId, share, ['ok.txt', '../x'])), 'EPATH')
})

test('a folder name that would escape is refused before any file', async (t) => {
  const ctx = await setupOwnedShare(t, { name: 'Vault' })
  const share = { ...ctx.share, name: '..', owner: 'peer'.padEnd(64, '0') }
  t.is(await refusal(() => requestShareDownloads(ctx.spaceId, share, ['a.txt'])), 'EPATH')
  t.is(await refusal(() => requestShareDownloads(ctx.spaceId, { ...share, name: 'a/b' }, ['a.txt'])), 'EPATH', 'a separator in the name is refused too')
})

test('a mirrored folder answers mirrored without starting anything', async (t) => {
  const ctx = await setupOwnedShare(t, { name: 'Vault' })
  const share = { ...ctx.share, owner: 'peer'.padEnd(64, '0') }
  await createForeignMount({ spaceId: ctx.spaceId, shareId: share.id, ownerKey: share.owner, mountPath: ctx.tmpDir('mirror'), enabled: true, status: 'active', attachedAt: Date.now(), syncedPaths: [] })
  t.alike(await requestShareDownloads(ctx.spaceId, share, ['a.txt']), { mirrored: true })
})
