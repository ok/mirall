import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { setupSelfMirror } from '../helpers/owned.js'
import { overlayBackend } from '../../src/shared/transfer/backends/overlay/index.js'
import { setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import {
  initialMaterializeScan, runMaterializeTick, restartForeignLoop, mirrorHealth,
  startForeignLoop, stopForeignLoop,
} from '../../src/shared/folders/foreign-folders.js'

// A converged mirror re-listed the owner's whole catalog and re-stat'd every file every 30s forever.
// The listing COUNT is the assertion: a wall-time or CPU measure could not go red, and the property
// under test is "no work was issued", not "the work was fast".
function instrument (t, { version = 1 } = {}) {
  const state = { listings: 0, version }
  const origList = overlayBackend.listPeerWithMeta
  const origVersion = overlayBackend.catalogVersion
  overlayBackend.listPeerWithMeta = async (...a) => { state.listings++; return await origList(...a) }
  overlayBackend.catalogVersion = async () => state.version
  t.teardown(() => {
    overlayBackend.listPeerWithMeta = origList
    overlayBackend.catalogVersion = origVersion
  })
  return state
}

async function converge (ctx) {
  await initialMaterializeScan(ctx.mount)
  await runMaterializeTick(ctx.spaceId, ctx.share.id)
}

test('a converged mirror issues no listing while the catalog head is unchanged', async (t) => {
  const ctx = await setupSelfMirror(t, { files: { 'a.txt': 'x', 'b.txt': 'y' } })
  const state = instrument(t)
  await converge(ctx)
  const settled = state.listings
  await runMaterializeTick(ctx.spaceId, ctx.share.id)
  await runMaterializeTick(ctx.spaceId, ctx.share.id)
  t.is(state.listings, settled, 'two further ticks did no work at all')
})

test('an owner append makes the very next tick walk', async (t) => {
  const ctx = await setupSelfMirror(t, { files: { 'a.txt': 'x' } })
  const state = instrument(t)
  await converge(ctx)
  const settled = state.listings
  await runMaterializeTick(ctx.spaceId, ctx.share.id)
  t.is(state.listings, settled, 'skipping while the head is still')
  state.version += 1
  await runMaterializeTick(ctx.spaceId, ctx.share.id)
  t.is(state.listings, settled + 1, 'a moved head walks immediately — no backstop wait')
})

test('the backstop walks on the Nth consecutive tick', async (t) => {
  const ctx = await setupSelfMirror(t, { files: { 'a.txt': 'x' } })
  // After setupSelfMirror, never before: booting the peer rebuilds the runtime config from the
  // bootstrap frame and would drop a cap set earlier.
  const cfg = getRuntimeConfig()
  setRuntimeConfig({ ...cfg, foreignFullWalkEvery: 3 })
  t.teardown(() => setRuntimeConfig(cfg))
  const state = instrument(t)
  await converge(ctx)
  const settled = state.listings
  await runMaterializeTick(ctx.spaceId, ctx.share.id)
  await runMaterializeTick(ctx.spaceId, ctx.share.id)
  t.is(state.listings, settled, 'two skips')
  await runMaterializeTick(ctx.spaceId, ctx.share.id)
  t.is(state.listings, settled + 1, 'the third tick walks regardless')
})

// The backstop's whole purpose. The catalog version cannot see a LOCAL deletion, and a foreign mount
// has no filesystem watcher, so without it nothing would ever notice the file was gone.
test('a locally deleted mirror file is repaired by the backstop', async (t) => {
  const ctx = await setupSelfMirror(t, { files: { 'a.txt': 'x' } })
  const cfg = getRuntimeConfig()
  setRuntimeConfig({ ...cfg, foreignFullWalkEvery: 2 })
  t.teardown(() => setRuntimeConfig(cfg))
  instrument(t)
  await converge(ctx)
  const mirrored = path.join(ctx.mirrorPath, 'a.txt')
  t.ok(fs.existsSync(mirrored), 'materialized')
  fs.unlinkSync(mirrored)
  // fullWalkEvery 2 means one skip then a walk: the deletion is invisible to the catalog version, so
  // only the backstop tick can see it.
  await runMaterializeTick(ctx.spaceId, ctx.share.id)
  t.absent(fs.existsSync(mirrored), 'the skipping tick cannot see a local deletion — by design')
  await runMaterializeTick(ctx.spaceId, ctx.share.id)
  t.ok(fs.existsSync(mirrored), 're-materialized by the backstop, with no catalog change at all')
})

// The liveness watchdog restarts a mirror whose pass has been in flight without progress, so a skip
// that left a pass open would tear down a perfectly converged mirror every stall window, forever.
//
// This is a GUARD, not a red-first regression test, and the distinction is worth stating: the
// start/end bracket lives in runMaterializeTick, outside the function the skip was added to, so the
// skip cannot bypass it today and this assertion passes with or without the change. It earns its
// place only against a future refactor that moves the skip up into the interval — which is the
// shape a reader would naturally reach for, and the reason the skip is where it is.
test('a skipping tick completes a pass, so the liveness watchdog sees a healthy mirror', async (t) => {
  const ctx = await setupSelfMirror(t, { files: { 'a.txt': 'x' } })
  instrument(t)
  // mirrorHealth only reports mounts with a live loop, so the loop is the subject here. A long poll
  // keeps its own interval out of the assertion.
  const cfg = getRuntimeConfig()
  setRuntimeConfig({ ...cfg, foreignPollIntervalMs: 600_000 })
  t.teardown(() => setRuntimeConfig(cfg))
  await startForeignLoop({ spaceId: ctx.spaceId, shareId: ctx.share.id })
  t.teardown(() => stopForeignLoop(ctx.spaceId, ctx.share.id))

  await converge(ctx)
  await runMaterializeTick(ctx.spaceId, ctx.share.id)
  const rows = mirrorHealth({ now: Date.now() + 60 * 60 * 1000 })
  t.ok(rows.length > 0, 'the mount has a live loop to report on')
  for (const row of rows) t.ok(row.ok, `mirror ${row.shareId} healthy an hour after its last walk`)
})

test('an incomplete listing never sets the watermark', async (t) => {
  const ctx = await setupSelfMirror(t, { files: { 'a.txt': 'x', 'b.txt': 'y' } })
  const state = instrument(t)
  // Incomplete from the first pass on: a drain that timed out mid-catalog cannot prove the mirror
  // holds everything, so no pass may converge and every tick must keep walking.
  ctx.listing.complete = false
  await converge(ctx)
  const afterFirst = state.listings
  await runMaterializeTick(ctx.spaceId, ctx.share.id)
  await runMaterializeTick(ctx.spaceId, ctx.share.id)
  t.is(state.listings, afterFirst + 2, 'both further ticks walked')
})

test('a restart clears the watermark', async (t) => {
  const ctx = await setupSelfMirror(t, { files: { 'a.txt': 'x' } })
  const state = instrument(t)
  await converge(ctx)
  const settled = state.listings
  await runMaterializeTick(ctx.spaceId, ctx.share.id)
  t.is(state.listings, settled, 'skipping before the restart')
  await restartForeignLoop(ctx.spaceId, ctx.share.id)
  await runMaterializeTick(ctx.spaceId, ctx.share.id)
  t.ok(state.listings > settled, 'the first tick after a restart walks')
})

// The optional-member contract: a backend that cannot answer costs work, never correctness.
test('a backend with no catalogVersion walks every tick, exactly as before', async (t) => {
  const ctx = await setupSelfMirror(t, { files: { 'a.txt': 'x' } })
  const state = { listings: 0 }
  const origList = overlayBackend.listPeerWithMeta
  const origVersion = overlayBackend.catalogVersion
  overlayBackend.listPeerWithMeta = async (...a) => { state.listings++; return await origList(...a) }
  delete overlayBackend.catalogVersion
  t.teardown(() => { overlayBackend.listPeerWithMeta = origList; overlayBackend.catalogVersion = origVersion })
  await converge(ctx)
  const settled = state.listings
  await runMaterializeTick(ctx.spaceId, ctx.share.id)
  await runMaterializeTick(ctx.spaceId, ctx.share.id)
  t.is(state.listings, settled + 2, 'no probe means no skip')
})
