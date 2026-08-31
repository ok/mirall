import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { freshPeer } from '../helpers/store.js'
import { createSpace } from '../../src/shared/spaces/space.js'
import { publishShare, generateShareId } from '../../src/shared/shares/shares.js'
import { getLocalPublicKeyHex } from '../../src/shared/spaces/profile.js'
import { saveForeignMount, getForeignMount } from '../../src/shared/folders/mount-store.js'
import { setRuntimeConfig, getRuntimeConfig, getResourceCaps } from '../../src/shared/core/runtime-config.js'
import {
  runMaterializeTick, startForeignLoop, stopForeignLoop, restartForeignLoop, mirrorHealth,
  unmountForeignFolder,
} from '../../src/shared/folders/foreign-folders.js'
import { STALL_FACTOR } from '../../src/shared/folders/mirror-health.js'
import { MountsRuntime } from '../../src/worker/mounts-runtime.js'
import { createFakeIpc } from '../helpers/fake-ipc.js'
import { initOverlay, teardownOverlay, getOverlay } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'
import { overlayBackend } from '../../src/shared/transfer/backends/overlay/index.js'

// runMaterializeTick serialises passes per mount: a tick arriving while one runs is handed the
// in-flight promise. A pass that never settles therefore wedges the mount permanently — the poll
// interval keeps firing and every fire is a no-op. These tests reproduce that with an overlay
// fetchFile that hangs and a cancelFetch that does NOT rescue it, which is what separates a real
// wedge from the pause path (covered in foreign-pause-aborts-fetch.test.js).

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitUntil (pred, ms = 5000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (pred()) return
    await delay(20)
  }
  throw new Error('condition not met within ' + ms + 'ms')
}

async function wedgedMirror (t, { relPath = 'big.bin', contentHash = 'a'.repeat(64), size = 96 * 1024 * 1024, pollMs = 30_000 } = {}) {
  const ctx = await freshPeer(t)
  setRuntimeConfig({ ...getRuntimeConfig(), overlayEnabled: true, foreignPollIntervalMs: pollMs })
  await initOverlay()
  t.teardown(async () => { await teardownOverlay() })

  const space = await createSpace('Aurora')
  const spaceId = space.spaceId
  const shareId = generateShareId()
  await publishShare(spaceId, {
    id: shareId, type: 'owned-folder', name: 'Mirror', owner: getLocalPublicKeyHex(),
    contentMode: 'overlay', catalogKey: 'c'.repeat(64), createdAt: Date.now(),
  })

  const origListPeer = overlayBackend.listPeerWithMeta
  overlayBackend.listPeerWithMeta = async () => ({ entries: [{ relPath, contentHash, size }], complete: true })
  t.teardown(() => { overlayBackend.listPeerWithMeta = origListPeer })

  // fetchFile hangs and cancelFetch is inert, so nothing the stop path does can settle the pass.
  // The test holds every rejecter and settles them itself, which is what makes the ordering exact.
  const overlay = getOverlay()
  const origFetch = overlay.fetchFile
  const origCancel = overlay.cancelFetch
  t.teardown(() => { overlay.fetchFile = origFetch; overlay.cancelFetch = origCancel })
  const spy = { fetches: 0, rejecters: [], opts: [] }
  overlay.fetchFile = (_hash, options) => {
    spy.fetches += 1
    spy.opts.push(options)
    return new Promise((_res, rej) => { spy.rejecters.push(rej) })
  }
  overlay.cancelFetch = () => true

  await saveForeignMount({
    spaceId, shareId, ownerKey: getLocalPublicKeyHex(), mountPath: ctx.tmpDir('mirror'),
    enabled: true, attachedAt: Date.now(), status: 'active', syncedPaths: [],
  })
  await startForeignLoop({ spaceId, shareId })
  t.teardown(() => { stopForeignLoop(spaceId, shareId, { discardPartial: true }) })
  t.teardown(async () => { settleAll(spy); await delay(50) })
  return { spaceId, shareId, spy }
}

function cancelled () {
  const err = new Error('cancelled'); err.code = 'ECANCELLED'
  return err
}

function settleAll (spy) { for (const reject of spy.rejecters.splice(0)) reject(cancelled()) }

test('a hung pass wedges the mount and every later tick is a no-op', async (t) => {
  const { spaceId, shareId, spy } = await wedgedMirror(t)

  runMaterializeTick(spaceId, shareId)
  await waitUntil(() => spy.fetches === 1)

  for (let i = 0; i < 5; i++) runMaterializeTick(spaceId, shareId)
  await delay(50)
  t.is(spy.fetches, 1, 'five more ticks start no work — they coalesce onto the dead promise')
})

test('a wedged mirror is reported unhealthy, and a working one is not', async (t) => {
  const { spaceId, shareId, spy } = await wedgedMirror(t)

  runMaterializeTick(spaceId, shareId)
  await waitUntil(() => spy.fetches === 1)

  const pollMs = getResourceCaps().foreignPollIntervalMs
  t.is(mirrorHealth()[0].ok, true, 'a pass that just started is not wedged')

  const later = Date.now() + pollMs * STALL_FACTOR + 60_000
  const wedged = mirrorHealth({ now: later })
  t.is(wedged.length, 1, 'the mount with a live loop is reported')
  t.is(wedged[0].ok, false, 'no progress past the window reads as wedged')
  t.is(wedged[0].shareId, shareId)
})

// REGRESSION (FIX-R09-2: stopping the loop left the dead promise in the in-flight map, so a
// restarted loop coalesced straight back onto it and the folder stayed dead).
test('REGRESSION (FIX-R09-2: stopping and restarting the loop alone does not un-wedge it)', async (t) => {
  const { spaceId, shareId, spy } = await wedgedMirror(t)

  runMaterializeTick(spaceId, shareId)
  await waitUntil(() => spy.fetches === 1)

  stopForeignLoop(spaceId, shareId)
  await startForeignLoop({ spaceId, shareId })
  runMaterializeTick(spaceId, shareId)
  await delay(50)
  t.is(spy.fetches, 1, 'the fresh loop still coalesces onto the dead promise — clearing the map is the fix')

  await restartForeignLoop(spaceId, shareId)
  await waitUntil(() => spy.fetches === 2)
  t.is(spy.fetches, 2, 'restartForeignLoop clears the in-flight entry, so a real pass runs again')
})

// A single very large file over a slow link bumps progress once when the fetch begins and then
// spends hours inside fetchFile. Reading progress at the byte level is what stops that from being
// restarted every window.
test('bytes arriving keep a slow download healthy', async (t) => {
  const { spaceId, shareId, spy } = await wedgedMirror(t)

  runMaterializeTick(spaceId, shareId)
  await waitUntil(() => spy.fetches === 1)
  const startedAt = Date.now()
  const window = getResourceCaps().foreignPollIntervalMs * STALL_FACTOR

  await delay(60)
  t.is(mirrorHealth({ now: startedAt + window + 1 })[0].ok, false, 'no bytes yet — a stalled fetch is wedged')

  spy.opts[0].onProgress(4096)
  t.is(mirrorHealth({ now: startedAt + window + 1 })[0].ok, true, 'bytes arriving reset the stall clock')
})

test('the probe restarts a wedged mirror once, after two consecutive bad probes', async (t) => {
  const { spaceId, shareId, spy } = await wedgedMirror(t, { pollMs: 50 })
  const runtime = new MountsRuntime('mounts', { ipc: createFakeIpc() })

  runMaterializeTick(spaceId, shareId)
  await waitUntil(() => spy.fetches === 1)
  await waitUntil(() => mirrorHealth()[0]?.ok === false)

  await runtime.probeMirrorLiveness()
  t.is(spy.fetches, 1, 'one bad probe is not enough to act')

  await runtime.probeMirrorLiveness()
  await waitUntil(() => spy.fetches === 2)
  t.is(spy.fetches, 2, 'the second consecutive bad probe restarts the loop')
})

// The base clears the probe interval on close, but the probe awaits a restart — one already in
// flight when a shutdown starts would re-arm a loop stopAllForeignLoops just stopped.
test('the probe does nothing once the runtime is stopping', async (t) => {
  const { spaceId, shareId, spy } = await wedgedMirror(t, { pollMs: 50 })
  const runtime = new MountsRuntime('mounts', { ipc: createFakeIpc() })

  runMaterializeTick(spaceId, shareId)
  await waitUntil(() => spy.fetches === 1)
  await waitUntil(() => mirrorHealth()[0]?.ok === false)

  runtime._stopping = true
  await runtime.probeMirrorLiveness()
  await runtime.probeMirrorLiveness()
  await delay(50)
  t.is(spy.fetches, 1, 'no loop is restarted during teardown')
})

// The probe being correct proves nothing about it running: requestFailures and requestMetrics both
// shipped as no-ops because the producer was built and never wired. _open's interval body is what
// would silently drop it, and constructing the runtime for real needs a booted store, so the wiring
// is pinned by source text — the same way the crash-backstop suite pins boot.js.
test('REGRESSION (FIX-R09-2 wiring): the mount probe actually calls the liveness probe', (t) => {
  const src = fs.readFileSync(path.join(
    path.dirname(import.meta.url.replace(/^file:\/\//, '')), '..', '..', 'src', 'worker', 'mounts-runtime.js'
  ), 'utf8')
  const openBody = src.slice(src.indexOf('async _open()'), src.indexOf('async _resumeOwnedMounts'))
  t.ok(/this\.probeMirrorLiveness\(\)/.test(openBody), 'the periodic probe body calls probeMirrorLiveness')
  t.ok(/restartForeignLoop/.test(src), 'and the runtime imports the restart it drives')
})

// stopForeignLoop bumps cancelGen before the restart re-arms, so the pass being abandoned is
// generation-invalidated. Its trailing persist would otherwise re-save a mount the user removed.
test('a restart cannot resurrect a mount that was unmounted', async (t) => {
  const { spaceId, shareId, spy } = await wedgedMirror(t)

  runMaterializeTick(spaceId, shareId)
  await waitUntil(() => spy.fetches === 1)

  await unmountForeignFolder(spaceId, shareId)
  t.is(await getForeignMount(spaceId, shareId), null, 'the record is gone')

  await restartForeignLoop(spaceId, shareId)
  await delay(80)
  t.is(await getForeignMount(spaceId, shareId), null, 'and the restart did not bring it back')
  t.is(spy.fetches, 1, 'no pass runs for a mount that no longer exists')
})

test('the abandoned pass writes nothing once it finally settles', async (t) => {
  const { spaceId, shareId, spy } = await wedgedMirror(t)

  runMaterializeTick(spaceId, shareId)
  await waitUntil(() => spy.fetches === 1)

  await restartForeignLoop(spaceId, shareId)
  await waitUntil(() => spy.fetches === 2)

  const before = await getForeignMount(spaceId, shareId)
  const cancelled = new Error('cancelled'); cancelled.code = 'ECANCELLED'
  spy.rejecters.shift()(cancelled)
  await delay(80)

  const after = await getForeignMount(spaceId, shareId)
  t.alike(after.syncedPaths, before.syncedPaths, 'the stale pass recorded no ownership')
  t.is(after.status, before.status, 'and settled no status of its own')
})
