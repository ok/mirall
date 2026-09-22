import test from 'brittle'
import fs from 'bare-fs'
import { setupSelfMirror } from '../helpers/owned.js'
import { until } from '../helpers/bare-poll.js'
import { createForeignMount, deleteForeignMount, getForeignMount } from '../../src/shared/folders/mount-store.js'
import { autoPauseForeignMountGone } from '../../src/shared/folders/foreign-pause.js'
import { relocateForeignFolder, setForeignEnabled, startForeignLoop, stopForeignLoop, unmountForeignFolder } from '../../src/shared/folders/foreign-verbs.js'
import { initialMaterializeScan, mirrorIdleForTests, resetMirrorPass, runMaterializeTick, setMirrorReachability } from '../../src/shared/folders/mirror-pass.js'
import { mirrorHealth } from '../../src/shared/folders/foreign-folders.js'
import { STALL_FACTOR } from '../../src/shared/folders/mirror-policy.js'
import { getForeignPollIntervalMs } from '../../src/shared/core/runtime-config.js'
import { overlayBackend } from '../../src/shared/transfer/backends/overlay/index.js'
import { registerForeignFolders } from '../../src/worker/ipc/foreign-folders.js'

// A pass cancelled by a pause, relocate or unmount writes nothing after the verb that cancelled it:
// not the record, not the mirror state, not the disk.

async function selfMirror(t, files = { 'a.txt': 'alpha' }) {
  const ctx = await setupSelfMirror(t, { files })
  t.teardown(() => stopForeignLoop(ctx.spaceId, ctx.share.id))
  return { ctx, spaceId: ctx.spaceId, shareId: ctx.share.id }
}

const statuses = (ctx, shareId) => ctx.fake.events
  .filter((e) => e.type === 'event:foreign-folder-mount-status' && e.payload?.shareId === shareId)
  .map((e) => e.payload.status)

// A tick reads the record, then the catalog version, and binds the mirror state after that. Held on
// the version read, it can be cancelled while it still holds the record it read.
test('REGRESSION (FIX-448: a tick cancelled by an unmount does not resurrect the mount\'s state)', async (t) => {
  const { ctx, spaceId, shareId } = await selfMirror(t)
  await initialMaterializeScan(ctx.mount)
  // The old mount had mapped the owner's a.txt to a sibling; the next mount of this share must not
  // inherit that.
  const record = await getForeignMount(spaceId, shareId)
  await createForeignMount({ ...record, renamedPaths: { 'a.txt': 'a (1).txt' } })
  const version = overlayBackend.catalogVersion
  let reached = false
  let release
  const gate = new Promise((resolve) => { release = resolve })
  overlayBackend.catalogVersion = async (...args) => { reached = true; await gate; return await version(...args) }
  t.teardown(() => { overlayBackend.catalogVersion = version }, { order: -1 })

  const tick = runMaterializeTick(spaceId, shareId)
  await until(() => reached, 2000)
  await unmountForeignFolder(spaceId, shareId)
  release()
  await tick
  overlayBackend.catalogVersion = version

  const again = { ...ctx.mount, mountPath: ctx.tmpDir('mirror-again'), status: 'scanning' }
  await createForeignMount(again)
  await initialMaterializeScan(again)
  t.alike(fs.readdirSync(again.mountPath), ['a.txt'], 'the new mount writes the owner\'s file at its own name')
  t.alike((await getForeignMount(spaceId, shareId)).renamedPaths, {}, 'and carries no mapping from the old one')
})

test('REGRESSION (FIX-448: a pass paused mid-reconcile stops deleting)', async (t) => {
  const { ctx, spaceId, shareId } = await selfMirror(t, { 'a.txt': 'alpha', 'b.txt': 'bravo', 'c.txt': 'charlie' })
  await initialMaterializeScan(ctx.mount)
  const list = overlayBackend.listPeerWithMeta
  overlayBackend.listPeerWithMeta = async (...args) => {
    const got = await list(...args)
    return { ...got, entries: got.entries.filter((e) => e.relPath === 'c.txt') }
  }
  t.teardown(() => { overlayBackend.listPeerWithMeta = list }, { order: -1 })
  const unlink = fs.promises.unlink
  let unlinks = 0
  fs.promises.unlink = async (p) => {
    unlinks++
    if (unlinks === 1) await setForeignEnabled(spaceId, shareId, false)
    return await unlink(p)
  }
  t.teardown(() => { fs.promises.unlink = unlink })

  await runMaterializeTick(spaceId, shareId)
  fs.promises.unlink = unlink

  t.is(unlinks, 1, 'the deletion in hand finishes, and no other starts')
  t.is(fs.readdirSync(ctx.mirrorPath).length, 2, 'so one owner deletion is still pending on disk')
})

// A folder the pass cannot create is a local I/O fault like a file it cannot write.
test('REGRESSION (FIX-448: a folder the mirror cannot create pauses it instead of closing its status)', async (t) => {
  const { ctx, spaceId, shareId } = await selfMirror(t, { 'sub/b.txt': 'bravo' })
  fs.chmodSync(ctx.mirrorPath, 0o555)
  t.teardown(() => fs.chmodSync(ctx.mirrorPath, 0o755), { order: -1 })

  await runMaterializeTick(spaceId, shareId)

  const stored = await getForeignMount(spaceId, shareId)
  t.not(stored.status, 'active', 'a walk that could not write is not a good tick')
  t.is(stored.status, 'paused-error', 'it is a permission fault')
  t.is(stored.lastError, 'TRANSFER_PERMISSION')
})

// The probe reads the record, sees its folder gone, and pauses it. A relocate that lands in between
// has moved the mount to a folder that exists.
test('REGRESSION (FIX-448: a gone-folder probe does not pause a mount relocated under it)', async (t) => {
  const { ctx, spaceId, shareId } = await selfMirror(t)
  await initialMaterializeScan(ctx.mount)
  fs.rmSync(ctx.mirrorPath, { recursive: true, force: true })
  const moved = ctx.tmpDir('mirror-moved')

  const probing = autoPauseForeignMountGone(spaceId, shareId)
  const relocating = relocateForeignFolder(spaceId, shareId, moved)
  await Promise.all([probing, relocating])
  await mirrorIdleForTests(spaceId, shareId)

  const stored = await getForeignMount(spaceId, shareId)
  t.is(stored.mountPath, moved)
  t.is(stored.enabled, true, 'the relocated mount is not paused for the folder it left')
  t.not(stored.status, 'mount-point-gone')
})

// An adopt-only walk fetches nothing, so the fetch heartbeat never fires; the walk itself has to
// beat, or the supervisor reads a long scan as a wedge and restarts it.
test('REGRESSION (FIX-448: a walk that fetches nothing still reports progress)', async (t) => {
  const { ctx, shareId } = await selfMirror(t, { 'a.txt': 'alpha', 'b.txt': 'bravo' })
  let slow = true
  setMirrorReachability(() => {
    // absolute: a synchronous hold before the walk's first entry, which the verdict below measures.
    if (slow) {
      slow = false
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200)
    }
    return false
  })
  t.teardown(resetMirrorPass)
  await startForeignLoop(ctx.mount)
  const window = getForeignPollIntervalMs() * STALL_FACTOR
  let verdict = null
  const off = ctx.fake.onEmit((frame) => {
    if (verdict || frame.type !== 'event:foreign-folder-mount-status' || frame.payload?.status !== 'active') return
    verdict = mirrorHealth({ now: Date.now() + window - 100 }).find((m) => m.shareId === shareId)
  })
  t.teardown(off)

  await initialMaterializeScan(ctx.mount)

  t.ok(verdict, 'the scan was still in flight when it closed its status')
  t.ok(verdict.ok, 'and its entries count as progress')
})

async function mountThroughIpc(t) {
  const { ctx, spaceId, shareId } = await selfMirror(t)
  registerForeignFolders(ctx.fake.ipc, { log: { warn: () => {}, debug: () => {} }, intents: null })
  await deleteForeignMount(spaceId, shareId)
  const mountPath = ctx.tmpDir('mirror-fresh')
  const request = { spaceId, shareId, ownerKey: ctx.share.owner, mountPath }
  await ctx.fake.call('foreign-folder:mount', request)
  return { ctx, spaceId, shareId, request }
}

test('REGRESSION (FIX-448: mounting a mirrored share again does not replace its mount)', async (t) => {
  const { ctx, spaceId, shareId, request } = await mountThroughIpc(t)
  const elsewhere = ctx.tmpDir('mirror-elsewhere')

  await t.exception(() => ctx.fake.call('foreign-folder:mount', { ...request, mountPath: elsewhere }), /already mirrored/)
  t.is((await getForeignMount(spaceId, shareId)).mountPath, request.mountPath, 'the first mount stands')

  const again = await ctx.fake.call('foreign-folder:mount', request)
  t.is(again.mount.mountPath, request.mountPath, 'a repeated request answers with the mount it made')
  await mirrorIdleForTests(spaceId, shareId)
  t.is(statuses(ctx, shareId).filter((s) => s === 'scanning').length, 1, 'and scans it once')
})
