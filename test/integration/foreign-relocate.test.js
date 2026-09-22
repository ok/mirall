import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { freshPeer } from '../helpers/store.js'
import { createSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { publishShare, generateShareId } from '../../src/shared/shares/shares.js'
import { getLocalPublicKeyHex } from '../../src/shared/spaces/profile.js'
import { createForeignMount, getForeignMount, patchForeignMount } from '../../src/shared/folders/mount-store.js'
import { setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { isAutoPaused, pauseMount } from '../../src/shared/folders/foreign-pause.js'
import { relocateForeignFolder, scanForeignMount, setForeignEnabled, stopForeignLoop, unmountForeignFolder } from '../../src/shared/folders/foreign-verbs.js'
import { initOverlay, teardownOverlay, getOverlay } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'
import { overlayBackend } from '../../src/shared/transfer/backends/overlay/index.js'
import { setupSelfMirror } from '../helpers/owned.js'
import { until } from '../helpers/bare-poll.js'
import { initialMaterializeScan, mirrorIdleForTests, runMaterializeTick } from '../../src/shared/folders/mirror-pass.js'
import { mirrorHealth } from '../../src/shared/folders/foreign-folders.js'
import { registerForeignFolders } from '../../src/worker/ipc/foreign-folders.js'

async function setupMirror(t, { enabled = true, status = null } = {}) {
  const ctx = await freshPeer(t)
  setRuntimeConfig({ ...getRuntimeConfig(), overlayEnabled: true })
  await initOverlay()
  const space = await createSpace('Aurora')
  const spaceId = space.spaceId
  const shareId = generateShareId()
  await publishShare(spaceId, {
    id: shareId, type: 'owned-folder', name: 'Mirror', owner: getLocalPublicKeyHex(),
    contentMode: 'overlay', catalogKey: 'c'.repeat(64), createdAt: Date.now(),
  })
  const origListPeer = overlayBackend.listPeerWithMeta
  overlayBackend.listPeerWithMeta = async () => ({ entries: [], complete: true })
  const overlay = getOverlay()
  const origFetch = overlay.fetchFile
  overlay.fetchFile = async () => null
  const from = ctx.tmpDir('mirror-from')
  const to = ctx.tmpDir('mirror-to')
  await createForeignMount({
    spaceId, shareId, ownerKey: getLocalPublicKeyHex(), mountPath: from,
    enabled, status: status ?? (enabled ? 'active' : 'paused'), attachedAt: Date.now(),
    syncedPaths: ['already.bin'], renamedPaths: { 'clash.bin': 'clash (1).bin' },
  })
  t.teardown(async () => {
    stopForeignLoop(spaceId, shareId)
    overlayBackend.listPeerWithMeta = origListPeer
    overlay.fetchFile = origFetch
    await teardownOverlay()
  })
  return { ctx, spaceId, shareId, from, to }
}

test('relocate moves the mount and re-arms it', async (t) => {
  const { spaceId, shareId, from, to } = await setupMirror(t)
  const next = await relocateForeignFolder(spaceId, shareId, to)
  t.is(next.mountPath, to)
  t.is(next.enabled, true, 'relocating is not pausing')
  const stored = await getForeignMount(spaceId, shareId)
  t.is(stored.mountPath, to, 'the record is what survives a restart')
  t.not(stored.mountPath, from)
})

// The synced Set says "this mount already owns these files ON DISK". Carried across a move it
// would claim files exist at a path that has never been written to, and the next pass would skip
// exactly the files it needs to fetch.
test('relocate forgets what the old path owned', async (t) => {
  const { spaceId, shareId, to } = await setupMirror(t)
  const next = await relocateForeignFolder(spaceId, shareId, to)
  t.alike(next.syncedPaths, [], 'nothing is claimed at the new path yet')
  t.alike(next.renamedPaths, {}, 'and no collision workaround is inherited')
  const stored = await getForeignMount(spaceId, shareId)
  t.alike(stored.syncedPaths, [], 'persisted, not just in memory')
})

test('a paused mirror stays paused when it moves', async (t) => {
  const { spaceId, shareId, to } = await setupMirror(t, { enabled: false })
  const next = await relocateForeignFolder(spaceId, shareId, to)
  t.is(next.enabled, false, 'still the user’s pause')
  t.is(next.status, 'paused', 'and it still reads as paused')
})

// Relocating is how a user rescues a mirror whose disk went away, so the one thing it must not do
// is take that mirror out of the set the auto-resume looks at. 'paused' is deliberately NOT an
// auto-pause status, so collapsing into it would strand the mount until the user found Resume.
test('an AUTO-paused mirror keeps the status that makes it auto-resumable', async (t) => {
  for (const status of ['mount-point-gone', 'paused-enospc']) {
    const { spaceId, shareId, to } = await setupMirror(t, { enabled: false, status })
    const next = await relocateForeignFolder(spaceId, shareId, to)
    t.is(next.status, status, status + ' survives the move')
    t.ok(isAutoPaused(next), 'and the mount is still one the boot resume will pick up')
  }
})

test('relocating an unknown mount fails loudly', async (t) => {
  const { spaceId, to } = await setupMirror(t)
  await t.exception(() => relocateForeignFolder(spaceId, 'no-such-share', to), /Mount not found/)
})

// The bytes are not moved by us: whoever moved the folder keeps them, and a fresh destination is
// simply empty. Either way the old path is left exactly as it was.
test('relocate leaves the old directory untouched', async (t) => {
  const { spaceId, shareId, from, to } = await setupMirror(t)
  fs.writeFileSync(path.join(from, 'already.bin'), 'x')
  await relocateForeignFolder(spaceId, shareId, to)
  t.ok(fs.existsSync(path.join(from, 'already.bin')), 'nothing was deleted behind the user')
})

const statuses = (ctx, shareId) => ctx.fake.events
  .filter((e) => e.type === 'event:foreign-folder-mount-status' && e.payload?.shareId === shareId)
  .map((e) => e.payload.status)

// A mirror mounted and fully synced, then its folder moved on disk the way a user moves it — so the
// relocate points at a destination that already holds the mirrored bytes.
async function movedMirror(t) {
  const ctx = await setupSelfMirror(t, { files: { 'a.txt': 'alpha', 'sub/b.txt': 'bravo' } })
  const spaceId = ctx.spaceId
  const shareId = ctx.share.id
  t.teardown(() => stopForeignLoop(spaceId, shareId))
  await initialMaterializeScan(ctx.mount)
  const moved = path.join(ctx.tmpDir('mirror-dest'), 'Media')
  fs.renameSync(ctx.mirrorPath, moved)
  return { ctx, spaceId, shareId, moved }
}

// Relocate re-enters at scanning, and the pass that walks the new folder is the one that leaves it.
// The record is read once the relocate's passes have all settled.
test('REGRESSION (FIX-380: a relocated mirror settles to active after its first pass, not scanning)', async (t) => {
  const { ctx, spaceId, shareId, moved } = await movedMirror(t)
  t.is((await getForeignMount(spaceId, shareId)).status, 'active', 'precondition: the mirror settled at its first path')
  const seen = statuses(ctx, shareId).length

  await relocateForeignFolder(spaceId, shareId, moved)
  await mirrorIdleForTests(spaceId, shareId)

  const stored = await getForeignMount(spaceId, shareId)
  t.is(stored.mountPath, moved, 'the mount points at the new folder')
  t.is(stored.status, 'active', 'the first pass over the new folder closes scanning')
  t.is(stored.lastError ?? null, null, 'and carries no stale fault reason')
  const edges = statuses(ctx, shareId).slice(seen)
  t.is(edges[0], 'scanning', 'the relocate announces scanning')
  t.is(edges[edges.length - 1], 'active', 'and the renderer hears it leave')
})

// Relocating is "move the mount, not the bytes": a folder the user moved already holds the owner's
// versions, so the pass adopts them — no fetch, no rewrite — and records them as owned at the new path.
test('relocating onto the moved folder adopts its files without fetching or rewriting them', async (t) => {
  const { spaceId, shareId, moved } = await movedMirror(t)
  const overlay = getOverlay()
  const inner = overlay.fetchFile
  let fetches = 0
  overlay.fetchFile = async (...args) => { fetches += 1; return await inner(...args) }
  const before = fs.statSync(path.join(moved, 'a.txt')).mtimeMs

  await relocateForeignFolder(spaceId, shareId, moved)
  await mirrorIdleForTests(spaceId, shareId)

  t.is(fetches, 0, 'nothing is downloaded again')
  t.is(fs.readFileSync(path.join(moved, 'a.txt')).toString(), 'alpha', 'the bytes are untouched')
  t.is(fs.statSync(path.join(moved, 'a.txt')).mtimeMs, before, 'and the file was not rewritten')
  t.alike((await getForeignMount(spaceId, shareId)).syncedPaths.slice().sort(), ['a.txt', 'sub/b.txt'],
    'the mount owns them at the new path')
})

test('a relocate drops the old path\'s fault reason with its status', async (t) => {
  const { spaceId, shareId, moved } = await movedMirror(t)
  await patchForeignMount(spaceId, shareId, { lastError: 'TRANSFER_PERMISSION' })
  await relocateForeignFolder(spaceId, shareId, moved)
  t.is((await getForeignMount(spaceId, shareId)).lastError, null, 'the reason named a folder the mount no longer uses')
  await mirrorIdleForTests(spaceId, shareId)
})

test('a relocate scan that fails records a typed fault instead of leaving scanning', async (t) => {
  const { spaceId, shareId, moved } = await movedMirror(t)
  const list = overlayBackend.listPeerWithMeta
  overlayBackend.listPeerWithMeta = async () => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }) }
  t.teardown(() => { overlayBackend.listPeerWithMeta = list })

  await relocateForeignFolder(spaceId, shareId, moved)
  await mirrorIdleForTests(spaceId, shareId)
  await until(async () => (await getForeignMount(spaceId, shareId)).lastError === 'TRANSFER_PERMISSION', 2000)

  const stored = await getForeignMount(spaceId, shareId)
  t.not(stored.status, 'scanning', 'the mount does not read scanning for the rest of the session')
  t.is(stored.lastError, 'TRANSFER_PERMISSION', 'and it says why')
})

// The generation is taken when the scan is asked for, so a stop that lands while the share is
// still being read cancels it.
test('an initial scan stopped before it has read the share writes nothing', async (t) => {
  const ctx = await setupSelfMirror(t, { files: { 'a.txt': 'alpha' } })
  const spaceId = ctx.spaceId
  const shareId = ctx.share.id
  const scan = initialMaterializeScan(ctx.mount)
  stopForeignLoop(spaceId, shareId)
  t.alike(await scan, { stopped: true }, 'the scan saw itself stopped')
  t.is((await getForeignMount(spaceId, shareId)).status, 'scanning', 'and wrote no status over the stop')
  t.absent(fs.existsSync(path.join(ctx.mirrorPath, 'a.txt')), 'nor fetched anything')
})

// The initial scan holds its listing until the test releases it, so a pause, relocate or unmount can
// land while the scan is in flight. Its restore runs ahead of the fixture's own, which puts the
// original back last.
function gatedListing(t, { fault = null } = {}) {
  const inner = overlayBackend.listPeerWithMeta
  let release
  const gate = new Promise((resolve) => { release = resolve })
  overlayBackend.listPeerWithMeta = async (...args) => {
    await gate
    if (fault) throw fault
    return await inner(...args)
  }
  t.teardown(() => { overlayBackend.listPeerWithMeta = inner }, { order: -1 })
  return release
}

async function selfMirror(t, files = { 'a.txt': 'alpha' }) {
  const ctx = await setupSelfMirror(t, { files })
  t.teardown(() => stopForeignLoop(ctx.spaceId, ctx.share.id))
  return { ctx, spaceId: ctx.spaceId, shareId: ctx.share.id }
}

const liveLoop = (shareId) => () => mirrorHealth().some((m) => m.shareId === shareId)

test('REGRESSION (FIX-448: a scan finishing after a user pause leaves the pause in place)', async (t) => {
  const { ctx, spaceId, shareId } = await selfMirror(t)
  const release = gatedListing(t)
  const scan = initialMaterializeScan(ctx.mount)
  await setForeignEnabled(spaceId, shareId, false)
  const seen = statuses(ctx, shareId).length
  release()
  await scan

  const stored = await getForeignMount(spaceId, shareId)
  t.is(stored.status, 'paused', 'the pause is still what the record says')
  t.is(stored.enabled, false)
  t.absent(statuses(ctx, shareId).slice(seen).includes('active'), 'and the renderer never hears active')
})

test('REGRESSION (FIX-448: a scan finishing after an auto pause keeps it auto-resumable)', async (t) => {
  const { ctx, spaceId, shareId } = await selfMirror(t)
  const release = gatedListing(t)
  const scan = initialMaterializeScan(ctx.mount)
  await pauseMount(await getForeignMount(spaceId, shareId), 'paused-enospc', 'TRANSFER_DISK_FULL')
  release()
  await scan

  const stored = await getForeignMount(spaceId, shareId)
  t.is(stored.status, 'paused-enospc', 'the fault status survives the scan')
  t.is(stored.lastError, 'TRANSFER_DISK_FULL', 'and so does its reason')
  t.ok(isAutoPaused(stored), 'so the boot resume still picks it up')
})

test('REGRESSION (FIX-448: a scan of the old path writes nothing after a relocate)', async (t) => {
  const { ctx, spaceId, shareId } = await selfMirror(t)
  const moved = ctx.tmpDir('mirror-moved')
  const release = gatedListing(t)
  const scan = initialMaterializeScan(ctx.mount)
  await relocateForeignFolder(spaceId, shareId, moved)
  release()

  t.alike(await scan, { stopped: true }, 'the old path\'s scan saw itself cancelled')
  await mirrorIdleForTests(spaceId, shareId)
  t.absent(fs.existsSync(path.join(ctx.mirrorPath, 'a.txt')), 'and fetched nothing into the old folder')
  const stored = await getForeignMount(spaceId, shareId)
  t.is(stored.mountPath, moved, 'the mount points at the new folder')
  t.is(stored.status, 'active', 'which its own scan closed')
})

test('REGRESSION (FIX-448: a scan fault after a user pause does not turn it into an auto pause)', async (t) => {
  const { ctx, spaceId, shareId } = await selfMirror(t)
  const release = gatedListing(t, { fault: Object.assign(new Error('permission denied'), { code: 'EACCES' }) })
  const scanned = scanForeignMount(ctx.mount)
  await setForeignEnabled(spaceId, shareId, false)
  const seen = statuses(ctx, shareId).length
  release()
  await scanned

  const stored = await getForeignMount(spaceId, shareId)
  t.is(stored.status, 'paused', 'the user pause stands')
  t.absent(isAutoPaused(stored), 'so nothing auto-resumes a mirror the user paused')
  t.absent(statuses(ctx, shareId).slice(seen).includes('paused-error'), 'and no fault reaches the renderer')
})

async function mountThroughIpc(t) {
  const { ctx, spaceId, shareId } = await selfMirror(t)
  registerForeignFolders(ctx.fake.ipc, { log: { warn: () => {}, debug: () => {} }, intents: null })
  const release = gatedListing(t)
  await ctx.fake.call('foreign-folder:mount', {
    spaceId, shareId, ownerKey: ctx.share.owner, mountPath: ctx.tmpDir('mirror-fresh'),
  })
  return { ctx, spaceId, shareId, release }
}

test('REGRESSION (FIX-448: a mount paused during its first scan gets no poll loop)', async (t) => {
  const { spaceId, shareId, release } = await mountThroughIpc(t)
  await setForeignEnabled(spaceId, shareId, false)
  release()
  await mirrorIdleForTests(spaceId, shareId)
  t.absent(await until(liveLoop(shareId), 1000), 'the paused mount has no live interval')
})

test('REGRESSION (FIX-448: a mount unmounted during its first scan gets no poll loop)', async (t) => {
  const { spaceId, shareId, release } = await mountThroughIpc(t)
  await unmountForeignFolder(spaceId, shareId)
  release()
  await mirrorIdleForTests(spaceId, shareId)
  t.absent(await until(liveLoop(shareId), 1000), 'the unmounted mount has no live interval')
  t.is(await getForeignMount(spaceId, shareId), null, 'and no record came back')
})

// A pause that lands mid-relocate, after the relocate has read the record as enabled.
test('REGRESSION (FIX-448: a relocate does not re-arm a mirror paused while it was running)', async (t) => {
  const { ctx, spaceId, shareId } = await selfMirror(t)
  await initialMaterializeScan(ctx.mount)
  const moved = ctx.tmpDir('mirror-moved')
  let paused = null
  const off = ctx.fake.onEmit((frame) => {
    if (paused || frame.type !== 'event:foreign-folder-mount-status' || frame.payload?.status !== 'scanning') return
    paused = setForeignEnabled(spaceId, shareId, false)
  })
  t.teardown(off)
  await relocateForeignFolder(spaceId, shareId, moved)
  await paused
  await mirrorIdleForTests(spaceId, shareId)

  t.is((await getForeignMount(spaceId, shareId)).status, 'paused', 'the pause stands')
  t.absent(await until(liveLoop(shareId), 1000), 'and the paused mirror has no live interval')
})

// The user's own file sits at the owner's path, so the scan fetches the owner's copy to a sibling and
// maps it. A pause landing right after that fetch cancels the scan's final write; the mapping must
// survive it, or the resume re-derives the path, takes the user's file for a mirror edit and fetches
// a second copy.
test('REGRESSION (FIX-448: a collision sibling fetched by a cancelled scan stays mapped)', async (t) => {
  const { ctx, spaceId, shareId } = await selfMirror(t)
  fs.writeFileSync(path.join(ctx.mirrorPath, 'a.txt'), 'mine')
  const overlay = getOverlay()
  const inner = overlay.fetchFile
  let pausing = null
  overlay.fetchFile = async (...args) => {
    const got = await inner(...args)
    pausing ??= setForeignEnabled(spaceId, shareId, false)
    await pausing
    return got
  }
  t.teardown(() => { overlay.fetchFile = inner }, { order: -1 })
  await initialMaterializeScan(ctx.mount)
  overlay.fetchFile = inner

  await setForeignEnabled(spaceId, shareId, true)
  await mirrorIdleForTests(spaceId, shareId)

  t.alike(fs.readdirSync(ctx.mirrorPath).sort(), ['a (1).txt', 'a.txt'], 'no second copy and no conflict copy')
  t.is(fs.readFileSync(path.join(ctx.mirrorPath, 'a.txt')).toString(), 'mine', 'the user\'s file is untouched')
  t.is(fs.readFileSync(path.join(ctx.mirrorPath, 'a (1).txt')).toString(), 'alpha', 'the owner\'s copy is the sibling')
  t.alike((await getForeignMount(spaceId, shareId)).renamedPaths, { 'a.txt': 'a (1).txt' }, 'and the record maps it')
})

// Only the initial scan writes `active`; a scan that faulted or could not read the share leaves the
// status open, and the first tick that walks the catalog closes it.
test('REGRESSION (FIX-448: the first good tick after a scan fault closes the fault)', async (t) => {
  const { ctx, spaceId, shareId } = await selfMirror(t)
  await patchForeignMount(spaceId, shareId, { status: 'paused-error', lastError: 'TRANSFER_PERMISSION' })
  const seen = statuses(ctx, shareId).length

  await runMaterializeTick(spaceId, shareId)

  const stored = await getForeignMount(spaceId, shareId)
  t.is(stored.status, 'active', 'the mirror is syncing again, and says so')
  t.is(stored.lastError, null, 'with no stale reason')
  t.alike(statuses(ctx, shareId).slice(seen), ['active'], 'and the renderer hears it')
})

test('REGRESSION (FIX-448: the first good tick closes a scan that never read the share)', async (t) => {
  const { spaceId, shareId } = await selfMirror(t)
  t.is((await getForeignMount(spaceId, shareId)).status, 'scanning', 'precondition: no scan closed it')
  await runMaterializeTick(spaceId, shareId)
  t.is((await getForeignMount(spaceId, shareId)).status, 'active')
})

test('a good tick leaves a closed status alone', async (t) => {
  const { ctx, spaceId, shareId } = await selfMirror(t)
  await initialMaterializeScan(ctx.mount)
  const seen = statuses(ctx, shareId).length
  await runMaterializeTick(spaceId, shareId)
  t.alike(statuses(ctx, shareId).slice(seen), [], 'no status edge from a tick')
})

// The relocate's follow-up tick is an ordinary tick: its failure is not the scan's.
test('REGRESSION (FIX-448: a failing tick after a relocate scan is not recorded as a scan fault)', async (t) => {
  const { spaceId, shareId, moved } = await movedMirror(t)
  const inner = overlayBackend.listPeerWithMeta
  let calls = 0
  overlayBackend.listPeerWithMeta = async (...args) => {
    if (++calls > 1) throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
    return await inner(...args)
  }
  t.teardown(() => { overlayBackend.listPeerWithMeta = inner }, { order: -1 })

  await relocateForeignFolder(spaceId, shareId, moved)
  await until(() => calls > 1, 2000)
  await mirrorIdleForTests(spaceId, shareId)

  t.absent(await until(async () => (await getForeignMount(spaceId, shareId)).status === 'paused-error', 500),
    'the scan got through, so no scan fault is recorded')
  t.is((await getForeignMount(spaceId, shareId)).status, 'active')
})
