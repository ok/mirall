import test from 'brittle'
import { fetchMain, patchMain, peekMain, resetMainStore, subscribeMain, configureMainStore } from '../../src/renderer/store/main-store.js'

// A bridge that records every call and lets a test settle each one by hand, so the dedup is
// asserted structurally rather than by timing — same shape as query-store.test.js's transport.
function fakeBridge () {
  const getCalls = []
  const setCalls = []
  const pendingGet = []
  return {
    getPrefs: () => { getCalls.push(1); return new Promise((resolve) => pendingGet.push(resolve)) },
    setPrefs: (patch) => { setCalls.push(patch); return Promise.resolve({ ...LOADED, ...patch }) },
    getCalls,
    setCalls,
    settleGet: (i, value) => pendingGet[i](value),
  }
}

const LOADED = { minimizeToTray: true, openAtLogin: false, showMenuBar: true }

function setup (t) {
  resetMainStore()
  const bridge = fakeBridge()
  configureMainStore(bridge)
  t.teardown(() => resetMainStore())
  return bridge
}

// REGRESSION (FIX-R04-8: each settings screen ran its own getPrefs() effect behind a hand-rolled
// `let cancelled` flag and kept a private copy in component state. Two screens meant two
// round-trips and two copies that could disagree after a write.)
test('REGRESSION (FIX-R04-8): concurrent consumers share ONE prefs:get round-trip', async (t) => {
  const bridge = setup(t)

  const a = fetchMain('main:prefs')
  const b = fetchMain('main:prefs')
  const c = fetchMain('main:prefs')
  t.is(bridge.getCalls.length, 1, 'three consumers, one request')

  bridge.settleGet(0, LOADED)
  t.alike(await a, LOADED, 'the first caller resolves')
  t.alike(await b, LOADED, 'so does the second')
  t.alike(await c, LOADED, 'and the third')
  t.is(bridge.getCalls.length, 1, 'still one request')
})

test('a warm cache serves later consumers without another round-trip', async (t) => {
  const bridge = setup(t)
  const first = fetchMain('main:prefs')
  bridge.settleGet(0, LOADED)
  await first

  t.alike(await fetchMain('main:prefs'), LOADED, 'served from cache')
  t.is(bridge.getCalls.length, 1, 'no second prefs:get')
})

test('a write publishes to EVERY subscriber, not only the writer', async (t) => {
  const bridge = setup(t)
  let writerNotified = 0
  let otherNotified = 0
  subscribeMain('main:prefs', () => { writerNotified++ })
  subscribeMain('main:prefs', () => { otherNotified++ })

  const load = fetchMain('main:prefs')
  bridge.settleGet(0, LOADED)
  await load
  t.is(otherNotified, 1, 'the load reached the second subscriber')

  await patchMain('main:prefs', { openAtLogin: true })
  t.ok(writerNotified >= 2, 'the writer saw the write')
  t.is(writerNotified, otherNotified, 'both subscribers saw exactly the same notifications')
  t.is(peekMain('main:prefs').data.openAtLogin, true, 'and the cache carries the new value')
})

test('a write is optimistic, then authoritative', async (t) => {
  const bridge = setup(t)
  const seen = []
  subscribeMain('main:prefs', () => { seen.push(peekMain('main:prefs').data.openAtLogin) })

  const load = fetchMain('main:prefs')
  bridge.settleGet(0, LOADED)
  await load

  await patchMain('main:prefs', { openAtLogin: true })
  // The optimistic publish paints before the round-trip; the authoritative one confirms it.
  t.alike(seen, [false, true, true], 'load, optimistic, authoritative')
  // The bare PATCH goes over the wire — main owns the merge, because it owns prefs it writes
  // itself and we would otherwise send a stale copy of them back.
  t.alike(bridge.setCalls, [{ openAtLogin: true }], 'one write, naming only what changed')
})

// The React 19 contract for useSyncExternalStore: getSnapshot is compared by identity, so a
// getSnapshot that allocates warns in DEV and can loop forever.
test('peekPrefs returns a cached value, never a fresh object', async (t) => {
  const bridge = setup(t)
  t.is(peekMain('main:prefs').data, undefined, 'undefined before the first load, and the SAME undefined every call')
  t.is(peekMain('main:prefs').data, peekMain('main:prefs').data, 'stable while cold')

  const load = fetchMain('main:prefs')
  bridge.settleGet(0, LOADED)
  await load

  t.is(peekMain('main:prefs').data, peekMain('main:prefs').data, 'stable while warm — no allocation per read')
})

test('unsubscribing the last consumer does not clear the cache', async (t) => {
  const bridge = setup(t)
  const unsubscribe = subscribeMain('main:prefs', () => {})
  const load = fetchMain('main:prefs')
  bridge.settleGet(0, LOADED)
  await load

  unsubscribe()
  t.alike(peekMain('main:prefs').data, LOADED, 'the value survives the last unsubscribe')
  t.alike(await fetchMain('main:prefs'), LOADED, 'and a remounting screen paints instantly')
  t.is(bridge.getCalls.length, 1, 'with no fresh round-trip')
})

test('a failed load leaves the store cold and retryable', async (t) => {
  resetMainStore()
  let attempts = 0
  configureMainStore({
    getPrefs: () => { attempts++; return attempts === 1 ? Promise.reject(new Error('main is not up')) : Promise.resolve(LOADED) },
    setPrefs: (patch) => Promise.resolve({ ...LOADED, ...patch }),
  })
  t.teardown(() => resetMainStore())

  await t.exception(fetchMain('main:prefs'), 'the rejection reaches the caller')
  t.is(peekMain('main:prefs').data, undefined, 'nothing cached')
  t.alike(await fetchMain('main:prefs'), LOADED, 'a later mount retries rather than being stuck on the dead promise')
})

test('writePrefs shows the merge but sends only the patch', async (t) => {
  const bridge = setup(t)
  const load = fetchMain('main:prefs')
  bridge.settleGet(0, LOADED)
  await load

  await patchMain('main:prefs', { openAtLogin: true })
  t.alike(bridge.setCalls, [{ openAtLogin: true }], 'main is sent the bare patch — it owns the merge')
  t.alike(peekMain('main:prefs').data, { ...LOADED, openAtLogin: true }, 'while the screen keeps every pref it showed')
})

// REGRESSION (FIX-PREFS-CLOBBER: writePrefs sent the renderer's MERGED record. `main:prefs` has no
// push channel and main flips firstHideNoticeShown itself when it first hides to the tray, so the
// renderer's cached copy still read false — and the next unrelated toggle wrote that false back
// over main's true, firing the tray notice a second time.)
test('REGRESSION (FIX-PREFS-CLOBBER): a write never clobbers a pref main owns', async (t) => {
  const bridge = setup(t)
  const load = fetchMain('main:prefs')
  // What the renderer read at boot: the notice had not been shown yet.
  bridge.settleGet(0, { ...LOADED, firstHideNoticeShown: false })
  await load

  // Main hid to the tray meanwhile and flipped the flag on its own copy. Nothing pushed it here.
  bridge.setPrefs = (patch) => {
    t.absent('firstHideNoticeShown' in patch, 'the patch does not name a pref the user did not touch')
    return Promise.resolve({ ...LOADED, firstHideNoticeShown: true, ...patch })
  }

  const persisted = await patchMain('main:prefs', { openAtLogin: true })
  t.is(persisted.firstHideNoticeShown, true, "main's value survived the write")
  t.is(peekMain('main:prefs').data.firstHideNoticeShown, true, 'and the cache took main\'s record as authoritative')
  t.is(peekMain('main:prefs').data.openAtLogin, true, 'while still carrying the change the user made')
})
