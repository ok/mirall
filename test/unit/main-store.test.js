import test from 'brittle'
import {
  configureMainStore, fetchMain, writeMain, setMainData, peekMain, subscribeMain,
  installMainPushBridge, resetMainStore,
} from '../../src/renderer/store/main-store.js'

// A bridge that records every call and lets a test settle each one by hand, so concurrency is
// asserted structurally rather than by timing — the same shape as query-store.test.js's transport.
function fakeBridge () {
  const calls = []
  const pending = []
  const pushListeners = []
  const defer = (label) => {
    calls.push(label)
    return new Promise((resolve, reject) => pending.push({ resolve, reject }))
  }
  return {
    calls,
    pushListeners,
    getPrefs: () => defer('getPrefs'),
    setPrefs: (v) => defer('setPrefs:' + JSON.stringify(v)),
    getDownloadFolder: () => defer('getDownloadFolder'),
    setDownloadFolder: (v) => defer('setDownloadFolder:' + v),
    getBandwidth: () => defer('getBandwidth'),
    setBandwidth: (v) => defer('setBandwidth:' + JSON.stringify(v)),
    getZoom: () => defer('getZoom'),
    setZoom: (v) => defer('setZoom:' + v),
    onZoomChanged: (fn) => { pushListeners.push(fn); return () => {} },
    settle: (i, v) => pending[i].resolve(v),
    fail: (i, e) => pending[i].reject(e),
  }
}

function setup (t) {
  resetMainStore()
  const bridge = fakeBridge()
  configureMainStore(bridge)
  t.teardown(() => resetMainStore())
  return bridge
}

const FOLDER = 'main:download-folder'
const CAPS = 'main:bandwidth'
const UNLIMITED = { downloadKBps: 0, uploadKBps: 0 }

test('concurrent reads of one fact issue a single bridge call', async (t) => {
  const bridge = setup(t)

  const a = fetchMain(FOLDER)
  const b = fetchMain(FOLDER)
  const c = fetchMain(FOLDER)
  t.is(bridge.calls.length, 1, 'three consumers, one call')

  bridge.settle(0, '/Users/me/Downloads')
  t.is(await a, '/Users/me/Downloads', 'the first caller resolves')
  t.is(await b, '/Users/me/Downloads', 'so does the second')
  t.is(await c, '/Users/me/Downloads', 'and the third')
  t.is(bridge.calls.length, 1, 'still one call')
})

test('a settled fact is served from cache without a second call', async (t) => {
  const bridge = setup(t)

  const first = fetchMain(FOLDER)
  bridge.settle(0, '/Users/me/Downloads')
  await first

  t.is(await fetchMain(FOLDER), '/Users/me/Downloads', 'served from cache')
  t.is(bridge.calls.length, 1, 'no second read')
})

test('a rejection reaches every joined caller and the entry retries afterwards', async (t) => {
  const bridge = setup(t)

  const a = fetchMain(FOLDER)
  const b = fetchMain(FOLDER)
  bridge.fail(0, new Error('main is not up'))

  await t.exception(a, 'the first caller sees the rejection')
  await t.exception(b, 'and so does the joined one')

  const retry = fetchMain(FOLDER)
  t.is(bridge.calls.length, 2, 'a later mount retries rather than being stuck on the dead promise')
  bridge.settle(1, '/Users/me/Downloads')
  t.is(await retry, '/Users/me/Downloads')
})

test('an unfetched entry reports loading, not empty', (t) => {
  setup(t)
  const snapshot = peekMain(FOLDER)
  t.is(snapshot.data, undefined, 'no value')
  t.is(snapshot.error, null, 'no error')
  t.ok(snapshot.loading, 'loading, so a screen does not paint a default over a value still arriving')
})

test('a settled entry stops reporting loading, including a failed one', async (t) => {
  const bridge = setup(t)

  const ok = fetchMain(FOLDER)
  bridge.settle(0, '/Users/me/Downloads')
  await ok
  t.absent(peekMain(FOLDER).loading, 'a resolved read settles')

  const bad = fetchMain(CAPS)
  bridge.fail(1, new Error('nope'))
  await t.exception(bad)
  t.absent(peekMain(CAPS).loading, 'and so does a failed one')
  t.ok(peekMain(CAPS).error, 'with the error on the entry')
})

test('the snapshot is a stable reference between changes and a new one after', async (t) => {
  const bridge = setup(t)
  const cold = peekMain(FOLDER)
  t.is(peekMain(FOLDER), cold, 'stable while cold — useSyncExternalStore compares by identity')

  const load = fetchMain(FOLDER)
  bridge.settle(0, '/Users/me/Downloads')
  await load

  const warm = peekMain(FOLDER)
  t.not(warm, cold, 'a new object once the value changed')
  t.is(peekMain(FOLDER), warm, 'and stable again afterwards')
})

// REGRESSION (FIX-R04-2-D3: a rejected setBandwidth left the screen showing a cap main never
// stored — the optimistic paint was never undone.)
test('REGRESSION (FIX-R04-2-D3): a failed write restores the previous value', async (t) => {
  const bridge = setup(t)

  const load = fetchMain(CAPS)
  bridge.settle(0, UNLIMITED)
  await load

  const write = writeMain(CAPS, { downloadKBps: 512, uploadKBps: 0 })
  t.alike(peekMain(CAPS).data, { downloadKBps: 512, uploadKBps: 0 }, 'painted optimistically')

  bridge.fail(1, new Error('main refused'))
  await t.exception(write, 'the rejection reaches the caller')
  t.alike(peekMain(CAPS).data, UNLIMITED, 'and the displayed cap is back to what main actually has')
  t.ok(peekMain(CAPS).error, 'with the failure on the entry')
})

test('a successful write publishes what main stored, not what was asked for', async (t) => {
  const bridge = setup(t)

  const write = writeMain(CAPS, { downloadKBps: 12, uploadKBps: 0 })
  bridge.settle(0, { downloadKBps: 32, uploadKBps: 0 })
  t.alike(await write, { downloadKBps: 32, uploadKBps: 0 }, 'the clamped value comes back')
  t.alike(peekMain(CAPS).data, { downloadKBps: 32, uploadKBps: 0 }, 'and it is what the entry holds')
})

test('a write publishes optimistically before it resolves', async (t) => {
  const bridge = setup(t)
  const seen = []
  subscribeMain(CAPS, () => { seen.push(peekMain(CAPS).data) })

  const write = writeMain(CAPS, { downloadKBps: 512, uploadKBps: 0 })
  t.alike(seen, [{ downloadKBps: 512, uploadKBps: 0 }], 'the subscriber saw it before the bridge settled')

  bridge.settle(0, { downloadKBps: 512, uploadKBps: 0 })
  await write
  t.is(seen.length, 2, 'and again when main confirmed')
})

test('a pushed value supersedes an in-flight read', async (t) => {
  const bridge = setup(t)

  const read = fetchMain('main:zoom')
  setMainData('main:zoom', 1.1)
  bridge.settle(0, 0.85)

  t.is(await read, 1.1, 'the superseded read resolves with the fresher value, not its own')
  t.is(peekMain('main:zoom').data, 1.1, 'and the entry keeps the pushed one')
})

test('a write that lands during a read wins over the read', async (t) => {
  const bridge = setup(t)

  const read = fetchMain(FOLDER)
  const write = writeMain(FOLDER, '/Users/me/Elsewhere')
  bridge.settle(1, '/Users/me/Elsewhere')
  await write

  bridge.settle(0, '/Users/me/Downloads')
  await read
  t.is(peekMain(FOLDER).data, '/Users/me/Elsewhere', 'the stale read cannot overwrite the write')
})

test('installMainPushBridge subscribes only facts that declare a push', (t) => {
  const bridge = setup(t)
  const uninstall = installMainPushBridge()

  t.is(bridge.pushListeners.length, 1, 'zoom is the only fact with a push channel')
  bridge.pushListeners[0](1.1)
  t.is(peekMain('main:zoom').data, 1.1, 'and a pushed factor lands in the entry a read would fill')
  uninstall()
})

test('subscribers are notified on settle and stop after unsubscribe', async (t) => {
  const bridge = setup(t)
  let notified = 0
  const off = subscribeMain(FOLDER, () => { notified++ })

  const load = fetchMain(FOLDER)
  bridge.settle(0, '/Users/me/Downloads')
  await load
  t.ok(notified > 0, 'the settle reached the subscriber')

  const before = notified
  off()
  setMainData(FOLDER, '/Users/me/Elsewhere')
  t.is(notified, before, 'and nothing after the unsubscribe')
})

test('an unknown fact name rejects rather than failing silently', async (t) => {
  setup(t)
  await t.exception(fetchMain('main:nope'), /unknown fact/, 'named in the error')
})

test('a read before configureMainStore fails loudly', async (t) => {
  resetMainStore()
  configureMainStore(null)
  t.teardown(() => resetMainStore())
  await t.exception(fetchMain(FOLDER), /no bridge configured/)
})
