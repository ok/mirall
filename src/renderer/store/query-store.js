import { scopeMatches } from '../../shared/contract/scope.js'

// One entry per [type, params]. The store owns FETCHING, DEDUP, CACHING and INVALIDATION — and
// nothing else. The never-blank merge and the terminal-vs-transient error policy stay in the hooks:
// they are per-view decisions (useShareFiles keeps its last good rows when a peer read comes back
// incomplete), and a store that interpreted responses would blank the most-used screen on a blip.
//
// Plain JS with an injected transport so it unit-tests under brittle-node, like the 13 other
// renderer modules that carry a .d.ts.
const entries = new Map()

let send = () => Promise.reject(new Error('query store: no transport configured'))

export function configureQueryStore ({ request }) {
  send = request
}

// Params are sorted so { a, b } and { b, a } are one entry rather than two.
function normalizeScopes (scopes) {
  if (!scopes) return []
  return Array.isArray(scopes) ? scopes : [scopes]
}

export function keyOf (type, params = {}) {
  const parts = Object.keys(params).sort().map((k) => `${k}=${String(params[k])}`)
  return parts.length ? `${type}?${parts.join('&')}` : type
}

// A view may re-derive on SEVERAL scopes — useSpaces watches members and join-requests,
// useSpaceStorage watches files, share-files and shares — so an entry holds a list, not one.
function entryFor (key, scopes) {
  let entry = entries.get(key)
  if (!entry) {
    entry = {
      data: undefined,
      error: null,
      promise: null,
      seq: 0,
      scopes: scopes ?? [],
      subscribers: new Set(),
      // Remembered so an invalidated entry can refetch itself: the subscriber that re-derives on a
      // hint is not the one that knows the request.
      type: null,
      params: null,
      coalesceMs: 0,
      timer: null,
      pendingHint: false,
      snapshot: { data: undefined, error: null, loading: true },
    }
    entries.set(key, entry)
  }
  if (scopes && scopes.length && entry.scopes.length === 0) entry.scopes = scopes
  return entry
}

// A NEW object when the value changes and the SAME object when it has not: useSyncExternalStore
// compares snapshots by identity, so a fresh object on every read would loop forever.
// An entry that has never resolved reports LOADING even before its fetch starts. The first render
// happens before the effect that fetches, so reporting false there would paint the "nothing shared
// yet" hero over a space whose content is still on its way.
const EMPTY_SNAPSHOT = Object.freeze({ data: undefined, error: null, loading: true })

function snapshotOf (entry) {
  const settled = entry.data !== undefined || entry.error !== null
  return { data: entry.data, error: entry.error, loading: entry.promise !== null || !settled }
}

// Keeps the SAME object when nothing changed: useSyncExternalStore compares by identity, so
// allocating a structurally identical snapshot would re-render every subscriber for nothing.
function publish (entry) {
  const next = snapshotOf(entry)
  const prev = entry.snapshot
  if (prev && prev.data === next.data && prev.error === next.error && prev.loading === next.loading) return
  entry.snapshot = next
  for (const notify of entry.subscribers) notify()
}

export function fetchQuery (type, params = {}, scopes = null, { coalesceMs } = {}) {
  const key = keyOf(type, params)
  const entry = entryFor(key, normalizeScopes(scopes))
  entry.type = type
  entry.params = params
  if (coalesceMs != null) entry.coalesceMs = coalesceMs
  // The dedup: a second caller during an in-flight read joins it instead of issuing another
  // request. Nine of the thirteen round-trips one member change costs are this case.
  if (entry.promise) return entry.promise

  const seq = ++entry.seq
  const inFlight = send(type, params).then(
    (data) => {
      if (seq !== entry.seq) return entry.data
      entry.data = data
      entry.error = null
      entry.promise = null
      publish(entry)
      return data
    },
    (err) => {
      // Rethrown, never interpreted: the caller decides whether this error is terminal. The entry
      // keeps its last good data so a hook can choose to keep rendering it.
      if (seq === entry.seq) {
        entry.error = err
        entry.promise = null
        publish(entry)
      }
      throw err
    },
  )
  entry.promise = inFlight
  publish(entry)
  return inFlight
}

// Invalidation is by predicate, not by key: one hint may match many entries, which is exactly what
// the Scope vocabulary already expresses. The cached value SURVIVES so a view can paint instantly
// while the refetch runs.
export function invalidate (hint) {
  const touched = []
  for (const [key, entry] of entries) {
    if (!entry.scopes.some((view) => scopeMatches(hint, view))) continue
    entry.seq += 1
    entry.promise = null
    touched.push(key)
    publish(entry)
    // An entry nobody is watching is left stale and refetches when a view next mounts. One that IS
    // being watched refetches now, because "invalidate" with no refetch is just a slow way to show
    // stale data forever.
    if (entry.subscribers.size > 0 && entry.type) scheduleRefetch(entry)
  }
  return touched
}

// Per-entry coalescing with the LEADING + TRAILING shape makeCoalescer uses, not a resettable
// debounce: a hint arriving faster than the window would restart the timer forever and the view
// would never refresh at all — the opposite of what the window is for. The first hint refetches
// immediately; further hints inside the window collapse into one trailing refetch.
function refetch (entry) {
  if (entry.subscribers.size === 0) return
  fetchQuery(entry.type, entry.params, entry.scopes).catch(() => {})
}

function scheduleRefetch (entry) {
  if (!entry.coalesceMs) {
    refetch(entry)
    return
  }
  if (entry.timer) { entry.pendingHint = true; return }
  refetch(entry)
  entry.timer = setTimeout(function closeWindow () {
    entry.timer = null
    if (!entry.pendingHint) return
    entry.pendingHint = false
    scheduleRefetch(entry)
  }, entry.coalesceMs)
}

export function subscribeKey (key, notify) {
  const entry = entries.get(key) ?? entryFor(key, [])
  entry.subscribers.add(notify)
  return () => { entry.subscribers.delete(notify) }
}

// Read during render, so it must not touch the map: React requires getSnapshot to be pure, and an
// entry created here would be born with no scopes and never match an invalidation.
export function peek (key) {
  return entries.get(key)?.snapshot ?? EMPTY_SNAPSHOT
}

export function resetQueryStore () {
  entries.clear()
}

export function storeStats () {
  let inFlight = 0
  for (const entry of entries.values()) if (entry.promise) inFlight += 1
  return { entries: entries.size, inFlight }
}

// An out-of-band value: event:state PUSHES the space list rather than answering a fetch, and a
// pushed value must land in the same entry a fetch would fill or the two disagree. Bumps seq so an
// in-flight read cannot overwrite fresher pushed data.
export function setQueryData (type, params, data, scopes = null) {
  const key = keyOf(type, params)
  const entry = entryFor(key, normalizeScopes(scopes))
  entry.seq += 1
  entry.promise = null
  entry.data = data
  entry.error = null
  publish(entry)
  return key
}

// A read that must NOT join one already in flight. fetchQuery deliberately shares an in-flight
// promise, but a caller refreshing after a mutation needs post-mutation state: joining a read that
// started before the write commits would resolve with the stale list. Bumping seq abandons the
// older read so its late response cannot win.
export function refetchQuery (type, params = {}, scopes = null) {
  const key = keyOf(type, params)
  const entry = entries.get(key)
  if (entry) {
    entry.seq += 1
    entry.promise = null
  }
  return fetchQuery(type, params, scopes ?? entry?.scopes ?? null)
}

// Drop entries whose key a predicate rejects — a space that was left must not keep its roster (and
// its avatars) cached for the rest of the session. A drop, not an invalidate: there is no view left
// to re-derive, so keeping the stale value would only hold the memory.
// Forget the VALUE, keep the entry: a component may be subscribed to this key right now (SpaceView
// prunes while useShares and useMembers are mounted), and deleting the object would orphan those
// subscribers — they would never be notified again and never refetch, leaving the view stuck.
// An entry with no subscribers is removed outright, which is what bounds the map.
export function invalidateKey (shouldDrop) {
  const dropped = []
  for (const [key, entry] of [...entries]) {
    if (!shouldDrop(key)) continue
    dropped.push(key)
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null }
    if (entry.subscribers.size === 0) { entries.delete(key); continue }
    entry.seq += 1
    entry.promise = null
    entry.data = undefined
    entry.error = null
    publish(entry)
    if (entry.type) scheduleRefetch(entry)
  }
  return dropped
}
