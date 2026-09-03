import test from 'brittle'
import { getForeignMount } from '../../src/shared/folders/mount-store.js'
import { getResourceCaps } from '../../src/shared/core/runtime-config.js'
import {
  runMaterializeTick, startForeignLoop, stopForeignLoop, restartForeignLoop, mirrorHealth,
  unmountForeignFolder,
} from '../../src/shared/folders/foreign-folders.js'
import { STALL_FACTOR } from '../../src/shared/folders/mirror-health.js'
import { wedgedMirror, waitUntil, delay } from '../helpers/wedged-mirror.js'

// runMaterializeTick serialises passes per mount: a tick arriving while one runs is handed the
// in-flight promise. A pass that never settles therefore wedges the mount permanently — the poll
// interval keeps firing and every fire is a no-op. These tests cover the loop's own behaviour; the
// probe-and-budget policy that drives the restart is covered in subsystem-supervision.test.js.

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
