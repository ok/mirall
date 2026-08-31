import test from 'brittle'
import {
  configureQueryStore, fetchQuery, invalidate, keyOf, peek, subscribeKey, resetQueryStore, storeStats,
  setQueryData,
} from '../../src/renderer/store/query-store.js'

// A transport that records every call and lets a test settle each one by hand, so concurrency is
// asserted structurally rather than by timing.
function fakeTransport () {
  const calls = []
  const pending = []
  const request = (type, params) => {
    calls.push({ type, params })
    return new Promise((resolve, reject) => pending.push({ resolve, reject }))
  }
  return {
    request, calls,
    settle: (i, value) => pending[i].resolve(value),
    fail: (i, err) => pending[i].reject(err),
    count: () => calls.length,
  }
}

function setup (t) {
  resetQueryStore()
  const transport = fakeTransport()
  configureQueryStore({ request: transport.request })
  t.teardown(() => resetQueryStore())
  return transport
}

const tick = () => new Promise((r) => setTimeout(r, 0))

test('keyOf is stable across param order and distinguishes values', (t) => {
  t.is(keyOf('spaces:list'), 'spaces:list', 'no params means no suffix')
  t.is(keyOf('space:members', { a: 1, b: 2 }), keyOf('space:members', { b: 2, a: 1 }), 'order-independent')
  t.not(keyOf('space:members', { spaceId: 'A' }), keyOf('space:members', { spaceId: 'B' }))
})

// REGRESSION (FIX-QUERY-DEDUP: five useSpaces() call sites each issued their own spaces:list, and
// two hooks each fetched space:members. Nine of the thirteen round-trips one member change costs
// are the same request issued concurrently by a different subscriber.)
test('REGRESSION (FIX-QUERY-DEDUP): concurrent reads of one key issue a single request', async (t) => {
  const tr = setup(t)
  const a = fetchQuery('spaces:list')
  const b = fetchQuery('spaces:list')
  const c = fetchQuery('spaces:list')
  t.is(tr.count(), 1, 'three callers, one request')

  tr.settle(0, [{ spaceId: 'S1' }])
  const [ra, rb, rc] = await Promise.all([a, b, c])
  t.alike(ra, [{ spaceId: 'S1' }])
  t.alike(rb, ra, 'every joined caller gets the same value')
  t.alike(rc, ra)
})

test('a rejection reaches every joined caller and the entry retries afterwards', async (t) => {
  const tr = setup(t)
  const a = fetchQuery('spaces:list')
  const b = fetchQuery('spaces:list')
  const err = new Error('offline')

  tr.fail(0, err)
  await t.exception(a, 'the first caller sees the failure')
  await b.then(() => t.fail('should reject'), (e) => t.is(e, err, 'and so does the joined caller'))

  // The promise must be cleared, or the entry would be stuck on a poisoned promise forever.
  fetchQuery('spaces:list')
  t.is(tr.count(), 2, 'the next call retries rather than joining the dead read')
})

test('a cached value survives invalidation so a view can paint instantly', async (t) => {
  const tr = setup(t)
  const scope = { kind: 'files', spaceId: 'S1' }
  const p = fetchQuery('files:list', { spaceId: 'S1' }, scope)
  tr.settle(0, ['a.txt'])
  await p

  const key = keyOf('files:list', { spaceId: 'S1' })
  t.alike(peek(key).data, ['a.txt'])

  invalidate({ kind: 'files', spaceId: 'S1' })
  t.alike(peek(key).data, ['a.txt'], 'the stale value is still there to render')
  t.is(peek(key).loading, false, 'and nothing is in flight until someone refetches')
})

// The latest-wins property, previously hand-rolled as a seqRef in five hooks and missing in four.
test('an in-flight response that lands after an invalidate is discarded', async (t) => {
  const tr = setup(t)
  const scope = { kind: 'files', spaceId: 'S1' }
  const first = fetchQuery('files:list', { spaceId: 'S1' }, scope)
  invalidate({ kind: 'files', spaceId: 'S1' })

  tr.settle(0, ['stale'])
  await first
  const key = keyOf('files:list', { spaceId: 'S1' })
  t.is(peek(key).data, undefined, 'the superseded response never became the value')

  const second = fetchQuery('files:list', { spaceId: 'S1' }, scope)
  tr.settle(1, ['fresh'])
  await second
  t.alike(peek(key).data, ['fresh'], 'the read issued after the invalidate wins')
})

test('invalidate matches by scope predicate, not by key', async (t) => {
  const tr = setup(t)
  await settleAll(tr, [
    fetchQuery('files:list', { spaceId: 'S1' }, { kind: 'files', spaceId: 'S1' }),
    fetchQuery('files:list', { spaceId: 'S2' }, { kind: 'files', spaceId: 'S2' }),
    fetchQuery('share:list', { spaceId: 'S1' }, { kind: 'shares', spaceId: 'S1' }),
  ])

  const touched = invalidate({ kind: 'files', spaceId: 'S1' })
  t.alike(touched, [keyOf('files:list', { spaceId: 'S1' })], 'only the matching entry')
})

test('a broad hint invalidates every entry of its kind in the space', async (t) => {
  const tr = setup(t)
  await settleAll(tr, [
    fetchQuery('share:list-files', { spaceId: 'S1', shareId: 'A' }, { kind: 'share-files', spaceId: 'S1', shareId: 'A' }),
    fetchQuery('share:list-files', { spaceId: 'S1', shareId: 'B' }, { kind: 'share-files', spaceId: 'S1', shareId: 'B' }),
  ])
  const touched = invalidate({ kind: 'share-files', spaceId: 'S1' })
  t.is(touched.length, 2, 'a hint with no shareId is a wildcard across the space')
})

test('a narrow hint leaves a sibling share alone', async (t) => {
  const tr = setup(t)
  await settleAll(tr, [
    fetchQuery('share:list-files', { spaceId: 'S1', shareId: 'A' }, { kind: 'share-files', spaceId: 'S1', shareId: 'A' }),
    fetchQuery('share:list-files', { spaceId: 'S1', shareId: 'B' }, { kind: 'share-files', spaceId: 'S1', shareId: 'B' }),
  ])
  const touched = invalidate({ kind: 'share-files', spaceId: 'S1', shareId: 'A' })
  t.is(touched.length, 1, 'only share A')
})

test('subscribers are notified on settle and stop after unsubscribe', async (t) => {
  const tr = setup(t)
  const key = keyOf('spaces:list')
  let hits = 0
  const unsub = subscribeKey(key, () => { hits += 1 })

  const p = fetchQuery('spaces:list')
  t.is(hits, 0, 'starting a read changes nothing a view can see — it was already loading with no data')
  tr.settle(0, ['x'])
  await p
  t.is(hits, 1, 'notified when the value arrives')

  unsub()
  const q = fetchQuery('spaces:list')
  tr.settle(1, ['y'])
  await q
  t.is(hits, 1, 'an unsubscribed callback is never called again')
})

// useSyncExternalStore compares snapshots by identity: a fresh object per read would re-render
// forever, and a stale one would never re-render at all.
test('the snapshot is a stable reference between changes and a new one after', async (t) => {
  const tr = setup(t)
  const key = keyOf('spaces:list')
  const before = peek(key)
  t.is(peek(key), before, 'repeated reads return the same object')

  const p = fetchQuery('spaces:list')
  tr.settle(0, ['x'])
  await p
  const after = peek(key)
  t.not(after, before, 'a settle produces a new snapshot')
  t.is(peek(key), after, 'which is then stable again')
})

test('storeStats reports live entries and in-flight reads', async (t) => {
  const tr = setup(t)
  fetchQuery('spaces:list')
  fetchQuery('files:list', { spaceId: 'S1' })
  t.alike(storeStats(), { entries: 2, inFlight: 2 })
  tr.settle(0, [])
  await tick()
  t.is(storeStats().inFlight, 1, 'a settled read is no longer in flight')
})

async function settleAll (tr, promises) {
  promises.forEach((_, i) => tr.settle(i, []))
  await Promise.all(promises)
}

// Most views re-derive on more than one scope — useSpaces on members and join-requests,
// useSpaceStorage on files, share-files and shares. An entry that held one scope would miss
// invalidations the hook depends on.
test('an entry watching several scopes is invalidated by any of them', async (t) => {
  const tr = setup(t)
  const p = fetchQuery('spaces:list', {}, [{ kind: 'members' }, { kind: 'join-requests' }])
  tr.settle(0, ['seed'])
  await p

  t.is(invalidate({ kind: 'members', spaceId: 'S1' }).length, 1, 'the members axis matches')
  t.is(invalidate({ kind: 'join-requests', spaceId: 'S1' }).length, 1, 'and so does join-requests')
  t.is(invalidate({ kind: 'shares', spaceId: 'S1' }).length, 0, 'an unrelated kind does not')
})

test('a single scope may still be passed unwrapped', async (t) => {
  const tr = setup(t)
  const p = fetchQuery('files:list', { spaceId: 'S1' }, { kind: 'files', spaceId: 'S1' })
  tr.settle(0, [])
  await p
  t.is(invalidate({ kind: 'files', spaceId: 'S1' }).length, 1)
})

// event:state pushes the space list instead of answering a fetch. A pushed value has to land in the
// same entry a fetch would fill, or the two views of one fact disagree.
test('setQueryData fills the entry a fetch would have filled', async (t) => {
  setup(t)
  const key = setQueryData('spaces:list', {}, ['pushed'], { kind: 'members' })
  t.alike(peek(key).data, ['pushed'])
  t.is(peek(key).loading, false)
})

test('a pushed value supersedes an in-flight read', async (t) => {
  const tr = setup(t)
  const inFlight = fetchQuery('spaces:list')
  setQueryData('spaces:list', {}, ['pushed'])

  tr.settle(0, ['stale-fetch'])
  await inFlight
  t.alike(peek(keyOf('spaces:list')).data, ['pushed'],
    'the fetch that was already running cannot overwrite fresher pushed data')
})

// REGRESSION (FIX-367-STORE: a hook reads the snapshot on its FIRST render, before the effect that
// fetches has run. An entry that reported loading:false there would let SpaceView paint the
// "nothing shared yet" hero over a space whose content is still arriving — the same flash FIX-367
// fixed, reintroduced by the store.)
test('REGRESSION (FIX-367-STORE): an unfetched entry reports loading, not empty', (t) => {
  setup(t)
  const snap = peek(keyOf('spaces:list'))
  t.is(snap.data, undefined, 'no data yet')
  t.is(snap.loading, true, 'and it says so, so the empty hero stays down')
})

test('a settled entry stops reporting loading, including a failed one', async (t) => {
  const tr = setup(t)
  const ok = fetchQuery('spaces:list')
  tr.settle(0, ['a'])
  await ok
  t.is(peek(keyOf('spaces:list')).loading, false, 'resolved')

  const bad = fetchQuery('files:list', { spaceId: 'S1' })
  tr.fail(1, new Error('nope'))
  await bad.catch(() => {})
  t.is(peek(keyOf('files:list', { spaceId: 'S1' })).loading, false,
    'a failure settles too — otherwise a broken read spins forever')
})

test('a cached entry refetching still reports loading, with its stale data', async (t) => {
  const tr = setup(t)
  const scope = { kind: 'files', spaceId: 'S1' }
  const p = fetchQuery('files:list', { spaceId: 'S1' }, scope)
  tr.settle(0, ['old'])
  await p

  fetchQuery('files:list', { spaceId: 'S1' }, scope)
  const snap = peek(keyOf('files:list', { spaceId: 'S1' }))
  t.alike(snap.data, ['old'], 'the stale rows are still renderable')
  t.is(snap.loading, true, 'while the refresh runs')
})

// REGRESSION (FIX-QUERY-REFETCH: invalidate marked an entry stale and nothing refetched it — the
// hook's effect only re-runs when its key changes. A view would show stale data forever while the
// store reported it had "invalidated" the entry.)
test('REGRESSION (FIX-QUERY-REFETCH): an invalidated entry a view is watching refetches', async (t) => {
  const tr = setup(t)
  const scope = { kind: 'files', spaceId: 'S1' }
  const p = fetchQuery('files:list', { spaceId: 'S1' }, scope)
  tr.settle(0, ['old'])
  await p

  const unsub = subscribeKey(keyOf('files:list', { spaceId: 'S1' }), () => {})
  invalidate({ kind: 'files', spaceId: 'S1' })
  await tick()

  t.is(tr.count(), 2, 'the watched entry refetched itself')
  tr.settle(1, ['new'])
  await tick()
  t.alike(peek(keyOf('files:list', { spaceId: 'S1' })).data, ['new'])
  unsub()
})

test('an entry nobody is watching is left stale rather than refetched', async (t) => {
  const tr = setup(t)
  const scope = { kind: 'files', spaceId: 'S1' }
  const p = fetchQuery('files:list', { spaceId: 'S1' }, scope)
  tr.settle(0, ['old'])
  await p

  invalidate({ kind: 'files', spaceId: 'S1' })
  await tick()
  t.is(tr.count(), 1, 'no refetch for a view nobody has mounted')
})

// A large index emits one hint per catalog append. Without a window the storage summary would
// re-drain every share on every append.
test('coalescing collapses a burst of hints into one leading and one trailing refetch', async (t) => {
  const tr = setup(t)
  const scope = { kind: 'files', spaceId: 'S1' }
  const p = fetchQuery('space:storage-summary', { spaceId: 'S1' }, scope, { coalesceMs: 30 })
  tr.settle(0, { totalBytes: 1 })
  await p

  const unsub = subscribeKey(keyOf('space:storage-summary', { spaceId: 'S1' }), () => {})
  for (let i = 0; i < 5; i++) invalidate({ kind: 'files', spaceId: 'S1' })
  await new Promise((r) => setTimeout(r, 80))

  t.is(tr.count(), 3, 'five hints: one immediate refetch, one trailing — not five')
  unsub()
})

// REGRESSION (FIX-QUERY-STARVE: a resettable debounce restarts its window on every hint, so a hint
// stream faster than the window — which is exactly what a large index produces, one per catalog
// append — postpones the refetch forever and the view freezes at its pre-index value.)
test('REGRESSION (FIX-QUERY-STARVE): a sustained hint stream still refreshes the view', async (t) => {
  const tr = setup(t)
  const scope = { kind: 'files', spaceId: 'S1' }
  const p = fetchQuery('space:storage-summary', { spaceId: 'S1' }, scope, { coalesceMs: 50 })
  tr.settle(0, { totalBytes: 1 })
  await p
  const unsub = subscribeKey(keyOf('space:storage-summary', { spaceId: 'S1' }), () => {})

  const before = tr.count()
  // A hint every 20 ms for 300 ms — faster than the 50 ms window, the shape a large index emits.
  const stream = setInterval(() => invalidate({ kind: 'files', spaceId: 'S1' }), 20)
  await new Promise((r) => setTimeout(r, 300))
  clearInterval(stream)

  const refetches = tr.count() - before
  t.ok(refetches >= 4, `the view kept refreshing under a sustained stream (${refetches} refetches)`)
  unsub()
})
