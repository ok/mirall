import { scopeMatches } from '../../shared/contract/scope.js'
import { CODES } from '../../shared/contract/errors.js'
/** @import { RequestName, RequestParams } from '../../shared/contract/requests.js' */
/** @import { ScopePattern } from '../../shared/contract/scope.js' */
/** @import { RequestOptions } from '../ipc/ipc.js' */

/**
 * @template T
 * @typedef {{ data: T | undefined, error: Error | null, loading: boolean }} Snapshot
 */

/**
 * @typedef {object} Entry
 * @property {unknown} data
 * @property {Error | null} error
 * @property {Promise<unknown> | null} promise
 * @property {number} seq
 * @property {ScopePattern[]} scopes
 * @property {Set<() => void>} subscribers
 * @property {RequestName | null} type
 * @property {RequestParams | null} params
 * @property {AbortController | null} controller
 * @property {number} coalesceMs
 * @property {ReturnType<typeof setTimeout> | null} timer
 * @property {boolean} pendingHint
 * @property {Snapshot<unknown>} snapshot
 */

/** @typedef {(type: RequestName, params: RequestParams, opts: RequestOptions) => Promise<unknown>} Transport */
/** @typedef {ScopePattern | ScopePattern[] | null} Scopes */

// One entry per [type, params]. The store owns FETCHING, DEDUP, CACHING and INVALIDATION — and
// nothing else. The never-blank merge and the terminal-vs-transient error policy stay in the hooks:
// they are per-view decisions (useShareFiles keeps its last good rows when a peer read comes back
// incomplete), and a store that interpreted responses would blank the most-used screen on a blip.
//
// Plain JS with an injected transport so it unit-tests under brittle-node.
//
// The model, once: one entry per keyOf(type, params). invalidate(hint) selects entries by scope
// PREDICATE rather than by key — it bumps `seq` so a late response is discarded, aborts the read in
// flight, keeps the cached value so a view paints instantly, and refetches only entries that have
// subscribers, coalesced per entry. setQueryData lands a pushed value in that same entry.
// invalidateKey forgets values but keeps any entry that still has subscribers, dropping the rest.
// An entry keeps the scopes it was FIRST registered with.
/** @type {Map<string, Entry>} */
const entries = new Map()

/** @type {Transport} */
let send = () => Promise.reject(new Error('query store: no transport configured'))

/** @param {{ request: Transport }} opts */
export function configureQueryStore({ request }) {
  send = request
}

// Params are sorted so { a, b } and { b, a } are one entry rather than two.
/** @param {Scopes} scopes @returns {ScopePattern[]} */
function normalizeScopes(scopes) {
  if (!scopes) return []
  return Array.isArray(scopes) ? scopes : [scopes]
}

/** @param {RequestName} type @param {RequestParams} [params] */
export function keyOf(type, params = {}) {
  const parts = Object.keys(params).sort().map((k) => `${k}=${String(params[k])}`)
  return parts.length ? `${type}?${parts.join('&')}` : type
}

// A view may re-derive on SEVERAL scopes — useSpaces watches members and join-requests,
// useSpaceStorage watches files, share-files and shares — so an entry holds a list, not one.
/** @param {string} key @param {ScopePattern[]} scopes @returns {Entry} */
function entryFor(key, scopes) {
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
      // Aborts the read this entry currently has in flight. The store already DISCARDS a response
      // whose seq is stale; this is what stops the worker computing it.
      controller: null,
      coalesceMs: 0,
      timer: null,
      pendingHint: false,
      snapshot: { data: undefined, error: null, loading: true },
    }
    entries.set(key, entry)
  }
  // First registration wins: an entry re-requested with narrower scopes must keep the wider set, or
  // it would stop matching the hints the original view still depends on.
  if (scopes && scopes.length && entry.scopes.length === 0) entry.scopes = scopes
  return entry
}

// A NEW object when the value changes and the SAME object when it has not: useSyncExternalStore
// compares snapshots by identity, so a fresh object on every read would loop forever.
// An entry that has never resolved reports LOADING even before its fetch starts. The first render
// happens before the effect that fetches, so reporting false there would paint the "nothing shared
// yet" hero over a space whose content is still on its way.
/** @type {Snapshot<never>} */
export const EMPTY_SNAPSHOT = Object.freeze({ data: undefined, error: null, loading: true })

/** @param {Entry} entry @returns {Snapshot<unknown>} */
function snapshotOf(entry) {
  const settled = entry.data !== undefined || entry.error !== null
  return { data: entry.data, error: entry.error, loading: entry.promise !== null || !settled }
}

// Keeps the SAME object when nothing changed: useSyncExternalStore compares by identity, so
// allocating a structurally identical snapshot would re-render every subscriber for nothing.
/** @param {Entry} entry */
function publish(entry) {
  const next = snapshotOf(entry)
  const prev = entry.snapshot
  if (prev && prev.data === next.data && prev.error === next.error && prev.loading === next.loading) return
  entry.snapshot = next
  for (const notify of entry.subscribers) notify()
}

// Bumping `seq` says "the answer in flight is no longer wanted" — to the worker too, via the abort.
/** @param {Entry} entry */
function abandon(entry) {
  entry.seq += 1
  entry.promise = null
  entry.controller?.abort()
  entry.controller = null
}

/**
 * @template T
 * @param {RequestName} type
 * @param {RequestParams} [params]
 * @param {Scopes} [scopes]
 * @param {{ coalesceMs?: number }} [opts]
 * @returns {Promise<T>}
 */
export function fetchQuery(type, params = {}, scopes = null, { coalesceMs } = {}) {
  const key = keyOf(type, params)
  const entry = entryFor(key, normalizeScopes(scopes))
  entry.type = type
  entry.params = params
  if (coalesceMs != null) entry.coalesceMs = coalesceMs
  // The dedup: a second caller during an in-flight read joins it instead of issuing another
  // request. Nine of the thirteen round-trips one member change costs are this case.
  if (entry.promise) return /** @type {Promise<T>} */ (entry.promise)

  const seq = ++entry.seq
  const controller = new AbortController()
  entry.controller = controller
  // Cleared only by the read that owns it: a later fetch has already installed its own controller,
  // and clearing that one here would leave the newer read uncancellable.
  const release = () => { if (entry.controller === controller) entry.controller = null }
  const inFlight = send(type, params, { signal: controller.signal }).then(
    (data) => {
      release()
      if (seq !== entry.seq) return entry.data
      entry.data = data
      entry.error = null
      entry.promise = null
      publish(entry)
      return data
    },
    /** @param {Error & { code?: string }} err */
    (err) => {
      release()
      // A read WE abandoned coming back cancelled is our own doing: it resolves with the entry's
      // value, as the success path's stale-seq branch does, so aborting the worker's work stays
      // invisible to callers. Any OTHER error, or any error on a read still current, is rethrown
      // untouched — the caller decides whether it is terminal.
      if (seq !== entry.seq && err?.code === CODES.ECANCELLED) return entry.data
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
  return /** @type {Promise<T>} */ (inFlight)
}

/** @param {ScopePattern} hint */
export function invalidate(hint) {
  /** @type {string[]} */
  const touched = []
  for (const [key, entry] of entries) {
    if (!entry.scopes.some((view) => scopeMatches(hint, view))) continue
    abandon(entry)
    touched.push(key)
    publish(entry)
    // An entry nobody is watching is left stale and refetches when a view next mounts. One that IS
    // being watched refetches now, because "invalidate" with no refetch is just a slow way to show
    // stale data forever.
    if (entry.subscribers.size > 0 && entry.type) scheduleRefetch(entry)
  }
  return touched
}

// Per-entry coalescing with a LEADING + TRAILING shape, not a resettable
// debounce: a hint arriving faster than the window would restart the timer forever and the view
// would never refresh at all — the opposite of what the window is for. The first hint refetches
// immediately; further hints inside the window collapse into one trailing refetch.
/** @param {Entry} entry */
function refetch(entry) {
  if (entry.subscribers.size === 0 || !entry.type) return
  fetchQuery(entry.type, entry.params ?? {}, entry.scopes).catch(() => {})
}

/** @param {Entry} entry */
function scheduleRefetch(entry) {
  if (!entry.coalesceMs) {
    refetch(entry)
    return
  }
  if (entry.timer) { entry.pendingHint = true; return }
  refetch(entry)
  entry.timer = setTimeout(function closeWindow() {
    entry.timer = null
    if (!entry.pendingHint) return
    entry.pendingHint = false
    scheduleRefetch(entry)
  }, entry.coalesceMs)
}

/** @param {string} key @param {() => void} notify */
export function subscribeKey(key, notify) {
  const entry = entries.get(key) ?? entryFor(key, [])
  entry.subscribers.add(notify)
  return () => { entry.subscribers.delete(notify) }
}

// Read during render, so it must not touch the map: React requires getSnapshot to be pure, and an
// entry created here would be born with no scopes and never match an invalidation.
/** @template T @param {string} key @returns {Snapshot<T>} */
export function peek(key) {
  return /** @type {Snapshot<T>} */ (entries.get(key)?.snapshot ?? EMPTY_SNAPSHOT)
}

/** @internal */
export function resetQueryStore() {
  entries.clear()
}

// An out-of-band value: event:state PUSHES the space list rather than answering a fetch, and a
// pushed value must land in the same entry a fetch would fill or the two disagree. Bumps seq so an
// in-flight read cannot overwrite fresher pushed data.
/** @template T @param {RequestName} type @param {RequestParams} params @param {T} data @param {Scopes} [scopes] */
export function setQueryData(type, params, data, scopes = null) {
  const key = keyOf(type, params)
  const entry = entryFor(key, normalizeScopes(scopes))
  abandon(entry)
  entry.data = data
  entry.error = null
  publish(entry)
  return key
}

// A read that must NOT join one already in flight. fetchQuery deliberately shares an in-flight
// promise, but a caller refreshing after a mutation needs post-mutation state: joining a read that
// started before the write commits would resolve with the stale list. Bumping seq abandons the
// older read so its late response cannot win.
/** @template T @param {RequestName} type @param {RequestParams} [params] @param {Scopes} [scopes] @returns {Promise<T>} */
export function refetchQuery(type, params = {}, scopes = null) {
  const key = keyOf(type, params)
  const entry = entries.get(key)
  if (entry) abandon(entry)
  return fetchQuery(type, params, scopes ?? entry?.scopes ?? null)
}

// Read one param back out of a key. keyOf writes `k=String(v)` joined with `&` and encodes
// nothing, so the value is taken verbatim up to the next `&`.
/** @param {string} key @param {string} param */
function paramOf(key, param) {
  const q = key.indexOf('?')
  if (q === -1) return null
  for (const pair of key.slice(q + 1).split('&')) {
    const eq = pair.indexOf('=')
    if (eq !== -1 && pair.slice(0, eq) === param) return pair.slice(eq + 1)
  }
  return null
}

// Drop every cached entry of these request types whose `param` names something that is no longer
// live — the roster of a space that was left, the shares of one that was deleted. A key whose param
// cannot be read is KEPT: the prune is an eviction, and evicting on a key it failed to parse would
// drop live data.
/** @param {readonly RequestName[]} types @param {string} param @param {Iterable<string>} live */
export function pruneByParam(types, param, live) {
  const kinds = new Set(/** @type {readonly string[]} */ (types))
  const alive = new Set(live)
  return invalidateKey((key) => {
    const q = key.indexOf('?')
    if (!kinds.has(q === -1 ? key : key.slice(0, q))) return false
    const value = paramOf(key, param)
    return value === null ? false : !alive.has(value)
  })
}

// Drop entries whose key a predicate rejects — a space that was left must not keep its roster (and
// avatars) cached for the session. Forget the VALUE but keep any entry that still has subscribers
// (SpaceScreen prunes while useShares and useMembers are mounted): deleting it would orphan them,
// never notified and never refetching. An entry with no subscribers is removed, which bounds the map.
/** @param {(key: string) => boolean} shouldDrop */
export function invalidateKey(shouldDrop) {
  /** @type {string[]} */
  const dropped = []
  for (const [key, entry] of [...entries]) {
    if (!shouldDrop(key)) continue
    dropped.push(key)
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null }
    if (entry.subscribers.size === 0) { entry.controller?.abort(); entries.delete(key); continue }
    abandon(entry)
    entry.data = undefined
    entry.error = null
    publish(entry)
    if (entry.type) scheduleRefetch(entry)
  }
  return dropped
}
