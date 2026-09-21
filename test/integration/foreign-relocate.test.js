import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { freshPeer } from '../helpers/store.js'
import { createSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { publishShare, generateShareId } from '../../src/shared/shares/shares.js'
import { getLocalPublicKeyHex } from '../../src/shared/spaces/profile.js'
import { createForeignMount, getForeignMount, patchForeignMount } from '../../src/shared/folders/mount-store.js'
import { setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { isAutoPaused, recordMirrorScanFault } from '../../src/shared/folders/foreign-pause.js'
import { relocateForeignFolder, setForeignEnabled, stopForeignLoop } from '../../src/shared/folders/foreign-verbs.js'
import { initOverlay, teardownOverlay, getOverlay } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'
import { overlayBackend } from '../../src/shared/transfer/backends/overlay/index.js'
import { setupSelfMirror } from '../helpers/owned.js'
import { until } from '../helpers/bare-poll.js'
import { initialMaterializeScan, mirrorIdleForTests } from '../../src/shared/folders/mirror-pass.js'
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

// The initial scan holds its listing until the test releases it, so a pause or relocate can land
// inside the window between the scan's generation check and its final write — the record changes
// under the scan, but the loop is not yet stopped.
function gatedListing(t, { fault = null } = {}) {
  const inner = overlayBackend.listPeerWithMeta
  let release
  const gate = new Promise((resolve) => { release = resolve })
  overlayBackend.listPeerWithMeta = async (...args) => {
    await gate
    if (fault) throw fault
    return await inner(...args)
  }
  t.teardown(() => { overlayBackend.listPeerWithMeta = inner })
  return release
}

async function gatedScan(t, { fault = null } = {}) {
  const ctx = await setupSelfMirror(t, { files: { 'a.txt': 'alpha' } })
  const spaceId = ctx.spaceId
  const shareId = ctx.share.id
  t.teardown(() => stopForeignLoop(spaceId, shareId))
  const release = gatedListing(t, { fault })
  const scan = initialMaterializeScan(ctx.mount)
  return { ctx, spaceId, shareId, release, scan }
}

test('REGRESSION (FIX-448: a scan finishing after a user pause leaves the pause in place)', async (t) => {
  const { ctx, spaceId, shareId, release, scan } = await gatedScan(t)
  await patchForeignMount(spaceId, shareId, { enabled: false, status: 'paused' })
  const seen = statuses(ctx, shareId).length
  release()
  await scan

  const stored = await getForeignMount(spaceId, shareId)
  t.is(stored.status, 'paused', 'the pause is still what the record says')
  t.is(stored.enabled, false)
  t.absent(statuses(ctx, shareId).slice(seen).includes('active'), 'and the renderer never hears active')
})

test('REGRESSION (FIX-448: a scan finishing after an auto pause keeps it auto-resumable)', async (t) => {
  const { spaceId, shareId, release, scan } = await gatedScan(t)
  await patchForeignMount(spaceId, shareId, { enabled: false, status: 'paused-enospc', lastError: 'TRANSFER_DISK_FULL' })
  release()
  await scan

  const stored = await getForeignMount(spaceId, shareId)
  t.is(stored.status, 'paused-enospc', 'the fault status survives the scan')
  t.is(stored.lastError, 'TRANSFER_DISK_FULL', 'and so does its reason')
  t.ok(isAutoPaused(stored), 'so the boot resume still picks it up')
})

test('REGRESSION (FIX-448: a scan of the old path writes nothing over a relocate)', async (t) => {
  const { ctx, spaceId, shareId, release, scan } = await gatedScan(t)
  const moved = ctx.tmpDir('mirror-moved')
  await patchForeignMount(spaceId, shareId, { mountPath: moved, syncedPaths: [], renamedPaths: {}, status: 'scanning' })
  release()
  await scan

  const stored = await getForeignMount(spaceId, shareId)
  t.is(stored.mountPath, moved, 'the mount still points at the new folder')
  t.alike(stored.syncedPaths, [], 'and claims nothing the old path owned')
  t.is(stored.status, 'scanning', 'the new folder has not been scanned yet')
  t.absent(stored.initialScanCompletedAt, 'nor stamped done by the old path')
})

// The mount handler and the relocate verb both hand a rejected scan to recordMirrorScanFault.
test('REGRESSION (FIX-448: a scan fault after a user pause does not turn it into an auto pause)', async (t) => {
  const fault = Object.assign(new Error('permission denied'), { code: 'EACCES' })
  const { ctx, spaceId, shareId, release, scan } = await gatedScan(t, { fault })
  const recorded = scan.catch((err) => recordMirrorScanFault(spaceId, shareId, err, { mountPath: ctx.mount.mountPath }))
  await patchForeignMount(spaceId, shareId, { enabled: false, status: 'paused' })
  const seen = statuses(ctx, shareId).length
  release()
  await recorded

  const stored = await getForeignMount(spaceId, shareId)
  t.is(stored.status, 'paused', 'the user pause stands')
  t.absent(isAutoPaused(stored), 'so nothing auto-resumes a mirror the user paused')
  t.absent(statuses(ctx, shareId).slice(seen).includes('paused-error'), 'and no fault reaches the renderer')
})

test('REGRESSION (FIX-448: a mount paused during its first scan gets no poll loop)', async (t) => {
  const ctx = await setupSelfMirror(t, { files: { 'a.txt': 'alpha' } })
  const spaceId = ctx.spaceId
  const shareId = ctx.share.id
  t.teardown(() => stopForeignLoop(spaceId, shareId))
  const log = { warn: () => {}, debug: () => {} }
  registerForeignFolders(ctx.fake.ipc, { log, intents: null })
  const release = gatedListing(t)
  await ctx.fake.call('foreign-folder:mount', {
    spaceId, shareId, ownerKey: ctx.share.owner, mountPath: ctx.tmpDir('mirror-fresh'),
  })
  await setForeignEnabled(spaceId, shareId, false)
  release()
  await mirrorIdleForTests(spaceId, shareId)

  const live = () => mirrorHealth().some((m) => m.shareId === shareId)
  t.absent(await until(live, 1000), 'the paused mount has no live interval')
})
