import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { freshPeer } from '../helpers/store.js'
import { createSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { publishShare, generateShareId } from '../../src/shared/shares/shares.js'
import { getLocalPublicKeyHex } from '../../src/shared/spaces/profile.js'
import { createForeignMount, getForeignMount } from '../../src/shared/folders/mount-store.js'
import { setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { isAutoPaused } from '../../src/shared/folders/foreign-pause.js'
import { relocateForeignFolder, stopForeignLoop } from '../../src/shared/folders/foreign-verbs.js'
import { initOverlay, teardownOverlay, getOverlay } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'
import { overlayBackend } from '../../src/shared/transfer/backends/overlay/index.js'
import { setupSelfMirror } from '../helpers/owned.js'
import { initialMaterializeScan, runMaterializeTick } from '../../src/shared/folders/mirror-pass.js'

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
// A tick requested right after the relocate coalesces onto the pass the relocate started, so the
// record read below is the one that pass left.
test('REGRESSION (FIX-380: a relocated mirror settles to active after its first pass, not scanning)', async (t) => {
  const { ctx, spaceId, shareId, moved } = await movedMirror(t)
  t.is((await getForeignMount(spaceId, shareId)).status, 'active', 'precondition: the mirror settled at its first path')
  const seen = statuses(ctx, shareId).length

  await relocateForeignFolder(spaceId, shareId, moved)
  await runMaterializeTick(spaceId, shareId)

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
  await runMaterializeTick(spaceId, shareId)

  t.is(fetches, 0, 'nothing is downloaded again')
  t.is(fs.readFileSync(path.join(moved, 'a.txt')).toString(), 'alpha', 'the bytes are untouched')
  t.is(fs.statSync(path.join(moved, 'a.txt')).mtimeMs, before, 'and the file was not rewritten')
  t.alike((await getForeignMount(spaceId, shareId)).syncedPaths.slice().sort(), ['a.txt', 'sub/b.txt'],
    'the mount owns them at the new path')
})
