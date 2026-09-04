import test from 'brittle'
import { setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { acquireFetchSlot, drainFetchSlots, fetchSlotStats, resetFetchSlots, FETCH_OWNER_MIRROR } from '../../src/shared/transfer/backends/overlay/fetch-slots.js'
import * as reimported from '../../src/shared/transfer/backends/overlay/fetch-slots.js'

function withCap (t, cap) {
  const prev = getRuntimeConfig()
  setRuntimeConfig({ ...prev, downloadConcurrency: cap })
  t.teardown(() => { setRuntimeConfig(prev); resetFetchSlots() })
  resetFetchSlots()
}

// The whole point of the module: the cap used to be built inside createOverlayDownloadEngine, which
// is called once per channel, so two engines meant two independent gates and the mirror had none.
// semaphore.test.js covers the accounting; this covers the thing a factory structurally cannot say.
test('every importer draws from the same gate', async (t) => {
  withCap(t, 1)
  const held = await acquireFetchSlot({})
  t.is(reimported.fetchSlotStats().held, 1, 'a second import observes the first import\'s slot')

  let admitted = false
  reimported.acquireFetchSlot({}).then(() => { admitted = true })
  await new Promise((r) => setTimeout(r, 10))
  t.absent(admitted, 'and is gated by it')
  held()
})

test('the mirror can be drained without releasing the engines', async (t) => {
  withCap(t, 1)
  const held = await acquireFetchSlot({})
  const mirror = acquireFetchSlot({ owner: FETCH_OWNER_MIRROR })
  const engine = acquireFetchSlot({})
  t.is(fetchSlotStats().queued, 2)

  // ForeignMirrors closes before OverlayBackend, so its close must not release a download into an
  // overlay that is still live.
  drainFetchSlots(FETCH_OWNER_MIRROR)
  await mirror
  t.is(fetchSlotStats().queued, 1, 'the engine job is still parked')
  held()
  await engine
})

// OverlayBackend builds fresh engines on every _open. A per-instance semaphore died with them; a
// module singleton would carry a lost slot into every later lifetime and shrink the cap for good.
test('resetFetchSlots clears a held count from a previous lifetime', async (t) => {
  withCap(t, 1)
  await acquireFetchSlot({})
  t.is(fetchSlotStats().held, 1, 'a slot is outstanding')

  resetFetchSlots()
  t.is(fetchSlotStats().held, 0, 'the new lifetime starts empty')
  const next = await acquireFetchSlot({})
  t.ok(next, 'and admits immediately rather than queueing behind the leak')
  next()
})

test('the cap is read from the runtime config per acquire', async (t) => {
  withCap(t, 0)
  // 0 is the documented rollback path: it disables the gate rather than blocking everything.
  const releases = await Promise.all([acquireFetchSlot({}), acquireFetchSlot({}), acquireFetchSlot({})])
  t.is(fetchSlotStats().queued, 0, 'a cap of zero admits everything')
  for (const rel of releases) rel()
})
