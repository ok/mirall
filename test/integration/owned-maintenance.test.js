import test from 'brittle'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import crypto from 'hypercore-crypto'
import { freshPeer, offlineMemberRegistry } from '../helpers/store.js'
import { createFakeIpc } from '../helpers/fake-ipc.js'
import { until } from '../helpers/bare-poll.js'
import { initOverlayIpc, initLooseIpc } from '../helpers/overlay-ipc.js'
import { boot } from '../../src/worker/boot.js'
import { createSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { publishShare, generateShareId } from '../../src/shared/shares/shares.js'
import { getLocalPublicKeyHex, setProfile } from '../../src/shared/spaces/profile.js'
import { createOwnedMount } from '../../src/shared/folders/mount-store.js'
import { advertise, getOwnEntry } from '../../src/shared/shares/own-catalog.js'
import { markOwnedSource } from '../../src/shared/transfer/files.js'
import { serveIndex } from '../../src/shared/transfer/backends/overlay/overlay-serve-index.js'
import { getOverlay, initOverlay, teardownOverlay } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'
import { overlayBackend } from '../../src/shared/transfer/backends/overlay/index.js'
import { looseShareFile, looseSources } from '../../src/shared/transfer/backends/overlay/loose-publish.js'
import { rehydrateOwnedContent, sweepOwnedPresence } from '../../src/shared/transfer/backends/overlay/overlay-maintenance.js'
import { LOOSE_SHARE_ID } from '../../src/shared/transfer/transfer-id.js'

const silentLog = { debug() {}, info() {}, warn() {}, error() {} }

// One space holding an owned folder share (mounted unless `mounted: false`) and room for loose
// files, with the overlay instance up in-process.
async function setup(t, { files = {}, mounted = true } = {}) {
  const ctx = await freshPeer(t)
  const space = await createSpace('Aurora')
  const share = {
    id: generateShareId(),
    type: 'owned-folder',
    name: 'Vault',
    contentMode: 'overlay',
    owner: getLocalPublicKeyHex(),
    createdAt: Date.now(),
  }
  await publishShare(space.spaceId, share)
  const mountPath = ctx.tmpDir('mount')
  if (mounted) await createOwnedMount({ spaceId: space.spaceId, shareId: share.id, mountPath, ignore: [], createdAt: Date.now() })
  for (const [rel, contents] of Object.entries(files)) fs.writeFileSync(path.join(mountPath, rel), contents)
  initOverlayIpc(ctx.fake.ipc)
  initLooseIpc(ctx.fake.ipc)
  serveIndex.reset()
  looseSources.clear()
  await initOverlay()
  t.teardown(async () => {
    serveIndex.reset()
    await teardownOverlay()
  })
  return { ...ctx, spaceId: space.spaceId, share, mountPath }
}

async function publishFolderFile(ctx, rel) {
  await overlayBackend.publishAdd(ctx.spaceId, ctx.share, rel, path.join(ctx.mountPath, rel))
  return (await getOwnEntry(ctx.spaceId, ctx.share.id, rel)).contentHash
}

async function shareLooseFile(ctx, name, contents) {
  const abs = path.join(ctx.tmpDir('src'), name)
  fs.writeFileSync(abs, contents)
  await looseShareFile(ctx.spaceId, abs, name)
  return { abs, hash: (await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, name)).contentHash }
}

async function restartOverlay() {
  await teardownOverlay()
  serveIndex.reset()
  looseSources.clear()
  await initOverlay()
}

// A case-folding volume answers a stat for a name that differs only in case.
function foldsCase(dir) {
  const probe = path.join(dir, 'case-probe')
  fs.writeFileSync(probe, 'x')
  try { return fs.statSync(path.join(dir, 'CASE-PROBE')).isFile() } catch { return false } finally { fs.unlinkSync(probe) }
}

test('one rehydrate pass re-registers folder and loose files alike', async (t) => {
  const ctx = await setup(t, { files: { 'a.txt': 'folder bytes' } })
  const folderHash = await publishFolderFile(ctx, 'a.txt')
  const loose = await shareLooseFile(ctx, 'note.txt', 'loose bytes')

  await restartOverlay()
  t.absent(serveIndex.has(folderHash) || serveIndex.has(loose.hash), 'precondition: serve maps cleared')

  await rehydrateOwnedContent()
  t.ok(serveIndex.has(folderHash), 'the folder file is servable again')
  t.ok(serveIndex.has(loose.hash), 'the loose file is servable again')
  t.ok(looseSources.has(loose.abs), 'the loose reverse map is repopulated')
})

test('a folder share with no mount is skipped, and the loose share is still walked', async (t) => {
  const ctx = await setup(t, { mounted: false })
  const loose = await shareLooseFile(ctx, 'note.txt', 'loose bytes')

  await restartOverlay()
  await rehydrateOwnedContent()
  t.ok(serveIndex.has(loose.hash), 'the loose file is re-registered')
})

test('a folder root that vanished is skipped whole, and walked again once it returns', async (t) => {
  const ctx = await setup(t, { files: { 'a.txt': 'A', 'b.txt': 'B' } })
  await publishFolderFile(ctx, 'a.txt')
  await publishFolderFile(ctx, 'b.txt')

  const away = ctx.mountPath + '-away'
  fs.renameSync(ctx.mountPath, away)
  await sweepOwnedPresence()
  await sweepOwnedPresence()
  t.ok(await getOwnEntry(ctx.spaceId, ctx.share.id, 'a.txt'), 'an unavailable root never reads as an empty folder')
  t.ok(await getOwnEntry(ctx.spaceId, ctx.share.id, 'b.txt'), 'no entry of the share is retired')

  fs.renameSync(away, ctx.mountPath)
  await sweepOwnedPresence()
  await sweepOwnedPresence()
  t.ok(await getOwnEntry(ctx.spaceId, ctx.share.id, 'a.txt'), 'the returned root still holds its files')

  fs.unlinkSync(path.join(ctx.mountPath, 'a.txt'))
  await sweepOwnedPresence()
  await sweepOwnedPresence()
  t.absent(await getOwnEntry(ctx.spaceId, ctx.share.id, 'a.txt'), 'a file really gone is retired')
  t.ok(await getOwnEntry(ctx.spaceId, ctx.share.id, 'b.txt'), 'and its sibling stays')
})

test('a folder key that escapes the mount is reclaimed by the sweep', async (t) => {
  const ctx = await setup(t, { files: { 'a.txt': 'A' } })
  await publishFolderFile(ctx, 'a.txt')
  await advertise(ctx.spaceId, ctx.share.id, '../escape.txt', { size: 1, mtime: 1, contentHash: 'ab'.repeat(32) })

  await sweepOwnedPresence()
  await sweepOwnedPresence()
  t.absent(await getOwnEntry(ctx.spaceId, ctx.share.id, '../escape.txt'), 'the poison key names no file, so it is retired')
  t.ok(await getOwnEntry(ctx.spaceId, ctx.share.id, 'a.txt'), 'a real file beside it stays')
})

test('overlapping sweep calls share one pass', async (t) => {
  await setup(t)
  const first = sweepOwnedPresence()
  t.is(sweepOwnedPresence(), first, 'a call during a pass joins it rather than starting a second')
  await first
  const next = sweepOwnedPresence()
  t.not(next, first, 'a call after the pass starts a new one')
  await next
})

test('the sweep judges each kind by its own presence predicate', async (t) => {
  const ctx = await setup(t, { files: { 'Report.txt': 'folder bytes' } })
  if (!foldsCase(ctx.mountPath)) {
    t.pass('case-sensitive volume: a case-only rename is a real rename for both kinds')
    return
  }
  await publishFolderFile(ctx, 'Report.txt')
  const loose = await shareLooseFile(ctx, 'Note.txt', 'loose bytes')

  fs.renameSync(path.join(ctx.mountPath, 'Report.txt'), path.join(ctx.mountPath, 'report.txt'))
  fs.renameSync(loose.abs, path.join(path.dirname(loose.abs), 'note.txt'))
  await sweepOwnedPresence()
  await sweepOwnedPresence()

  t.absent(await getOwnEntry(ctx.spaceId, ctx.share.id, 'Report.txt'), 'a folder key is its exact name, so the old one is retired')
  t.ok(await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'Note.txt'), 'a loose source still opens under its recorded path, so it stays')
})

test('per-entry isolation holds for folder files', async (t) => {
  const ctx = await setup(t, { files: { 'a.txt': 'AAA', 'b.txt': 'BBB' } })
  await publishFolderFile(ctx, 'a.txt')
  const hashB = await publishFolderFile(ctx, 'b.txt')

  await restartOverlay()
  const overlay = getOverlay()
  const realRegister = overlay.registerFile.bind(overlay)
  overlay.registerFile = async (op, dp, meta) => {
    if (dp.endsWith('a.txt')) throw new Error('boom: a.txt unreadable')
    return realRegister(op, dp, meta)
  }
  t.teardown(() => { overlay.registerFile = realRegister })

  await rehydrateOwnedContent()
  t.ok(serveIndex.has(hashB), 'b.txt re-registered although a.txt threw')
})

// The rehydrate's sinks fall through on a null overlay instance, so one that ran ahead of it would
// leave a crash-interrupted entry unhashed; only a real second boot orders the two the way
// production does.
test('a boot re-hashes a crash-interrupted loose entry', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mirall-maintenance-'))
  const storage = path.join(root, 'app-storage')
  fs.mkdirSync(storage, { recursive: true })
  const downloads = path.join(root, 'dl')
  fs.mkdirSync(downloads)
  t.teardown(() => { try { fs.rmSync(root, { recursive: true, force: true }) } catch {} })
  const config = { storage, appVersion: '0.0.0-test', dev: true, verbose: false, downloadFolder: downloads }
  const masterSecret = crypto.randomBytes(32)
  const opts = { log: silentLog, swarm: false, masterSecret, memberRegistry: offlineMemberRegistry }

  const first = await boot(config, { ...opts, ipc: createFakeIpc().ipc })
  let firstOpen = true
  t.teardown(async () => { if (firstOpen) await first.close() })
  await setProfile({ displayName: 'Tester' })
  const space = await createSpace('Aurora')
  const abs = path.join(root, 'doc.pdf')
  fs.writeFileSync(abs, 'recoverable bytes')
  const st = fs.statSync(abs)
  await advertise(space.spaceId, LOOSE_SHARE_ID, 'doc.pdf', { size: st.size, mtime: st.mtimeMs, contentHash: null })
  await markOwnedSource(space.spaceId, '/doc.pdf', abs)
  await first.close()
  firstOpen = false

  const second = await boot(config, { ...opts, ipc: createFakeIpc().ipc })
  t.teardown(() => second.close())
  t.ok(await until(async () => !!(await getOwnEntry(space.spaceId, LOOSE_SHARE_ID, 'doc.pdf'))?.contentHash, 10000),
    'the null-hash entry is re-hashed from its recorded source')
})
