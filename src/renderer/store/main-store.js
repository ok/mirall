import { MAIN_QUERIES } from './main-queries.js'
/** @import { MainQueryName, MainQueryValue } from './main-queries.js' */
/** @import { MirallBridge } from '../platform/global.js' */
/** @import { Snapshot } from './query-store.js' */

/**
 * @typedef {object} Entry
 * @property {unknown} data
 * @property {Error | null} error
 * @property {Promise<unknown> | null} promise
 * @property {number} seq
 * @property {Set<() => void>} subscribers
 * @property {Snapshot<unknown>} snapshot
 */

// One shared copy per main-process fact, for the screens that read them.
//
// Not the query store: useQuery is typed to RequestName — the WORKER contract — and these are
// Electron MAIN calls (preload.js). Same shape, none of the scope/invalidation machinery: a main
// fact changes when THIS app writes it or main pushes it, and neither is a reconcile hint. No abort
// (ipcRenderer.invoke has no cancellation channel, and these reads are local), but `seq` stays: a
// write or a push can land while a read is outstanding.
// Plain JS with an injected bridge so it unit-tests under brittle-node, like query-store.js.
/** @type {Map<string, Entry>} */
const entries = new Map()

/** @type {MirallBridge | null} */
let bridge = null

/** @param {MirallBridge} b */
export function configureMainStore(b) {
  bridge = b
}

/** @type {Snapshot<never>} */
const EMPTY_SNAPSHOT = Object.freeze({ data: undefined, error: null, loading: true })

/** @param {MainQueryName} name @returns {Entry} */
function entryFor(name) {
  let entry = entries.get(name)
  if (!entry) {
    entry = { data: undefined, error: null, promise: null, seq: 0, subscribers: new Set(), snapshot: EMPTY_SNAPSHOT }
    entries.set(name, entry)
  }
  return entry
}

// An entry that has never settled reports LOADING even before its fetch starts: the first render
// happens before the effect that fetches, and reporting false there would paint a default over a
// value still on its way.
/** @param {Entry} entry @returns {Snapshot<unknown>} */
function snapshotOf(entry) {
  const settled = entry.data !== undefined || entry.error !== null
  return { data: entry.data, error: entry.error, loading: entry.promise !== null || !settled }
}

// Keeps the SAME object when nothing changed: useSyncExternalStore compares by identity, so a
// structurally identical fresh snapshot would re-render every subscriber for nothing.
/** @param {Entry} entry */
function publish(entry) {
  const next = snapshotOf(entry)
  const prev = entry.snapshot
  if (prev && prev.data === next.data && prev.error === next.error && prev.loading === next.loading) return
  entry.snapshot = next
  for (const notify of entry.subscribers) notify()
}

/** @template {MainQueryName} K @param {K} name @returns {{ spec: (typeof MAIN_QUERIES)[K], bridge: MirallBridge }} */
function specFor(name) {
  const spec = MAIN_QUERIES[name]
  if (!spec) throw new Error(`main store: unknown fact "${name}"`)
  if (!bridge) throw new Error('main store: no bridge configured')
  return { spec, bridge }
}

// The dedup and the cache: two screens mounting in one session each issued their own read and each
// kept a private copy in component state, which could disagree with the other after a write. A
// settled fact answers from the entry, so a remounting modal costs no round-trip at all.
/** @template {MainQueryName} K @param {K} name @returns {Promise<MainQueryValue[K]>} */
export function fetchMain(name) {
  /** @type {ReturnType<typeof specFor<K>>} */
  let resolved
  try {
    resolved = specFor(name)
  } catch (err) {
    return Promise.reject(err)
  }

  const entry = entryFor(name)
  if (entry.promise) return /** @type {Promise<MainQueryValue[K]>} */ (entry.promise)
  if (entry.data !== undefined) return Promise.resolve(/** @type {MainQueryValue[K]} */ (entry.data))

  const seq = ++entry.seq
  const inFlight = resolved.spec.read(resolved.bridge)
    .then(
      (data) => {
        // A write or a push that landed while this read was out has already published a FRESHER
        // value. Resolving with the entry's value rather than the stale one mirrors the query
        // store: a superseded read is not an error the caller asked about.
        if (seq !== entry.seq) return /** @type {MainQueryValue[K]} */ (entry.data)
        entry.data = data
        entry.error = null
        entry.promise = null
        publish(entry)
        return data
      },
      /** @param {Error} err */
      (err) => {
        // Cleared even on failure, so the entry is retryable rather than stuck on a dead promise.
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

// Optimistic, then authoritative, then rolled back — visible to every screen at once instead of
// only the one that issued the write. The rollback is what keeps a failed write from leaving the
// UI showing a value main never stored.
//
// `payload` is what main is SENT when that differs from what the app should show meanwhile: prefs
// send a bare patch (main merges it into the only authoritative copy) while displaying the merge.
// It defaults to `value`, which is the case for every fact whose write is a whole-value replace.
/**
 * @template {MainQueryName} K
 * @param {K} name
 * @param {MainQueryValue[K]} value
 * @param {{ payload?: MainQueryValue[K] | Partial<MainQueryValue[K]> }} [opts]
 * @returns {Promise<MainQueryValue[K]>}
 */
export async function writeMain(name, value, { payload = value } = {}) {
  const { spec, bridge } = specFor(name)
  const entry = entryFor(name)
  const previous = entry.data

  entry.seq += 1
  const mine = entry.seq
  entry.promise = null
  entry.data = value
  entry.error = null
  publish(entry)

  // Only a write nothing has superseded settles the entry: a newer write or a push already holds a
  // fresher value, which neither a late answer nor a late rollback may paint over.
  try {
    const persisted = await spec.write(bridge, /** @type {MainQueryValue[K]} */ (payload))
    if (entry.seq === mine) {
      entry.seq += 1
      entry.data = persisted
      publish(entry)
    }
    return persisted
  } catch (err) {
    // A superseded write is not the outcome: the newer write or push owns it, so this one resolves
    // with the value that replaced it rather than reporting a failure nothing on screen reflects.
    if (entry.seq !== mine) return /** @type {MainQueryValue[K]} */ (entry.data)
    // Roll back to the last value the app actually read, and do NOT record the error on the entry:
    // `error` means "there is no value to show, and here is why" (readError, folderReadError,
    // defaultError). A write failure belongs to the caller — writeMain throws it — and a recorded
    // one would outlive the action, because fetchMain answers a cached entry without clearing it.
    entry.seq += 1
    entry.data = previous
    publish(entry)
    throw err
  }
}

// A PATCH over writeMain's REPLACE, for the one fact main merges itself. The merge is what we
// DISPLAY (a screen keeps the values it already showed while the write is in flight); the bare
// patch is what main is SENT, so a key main owns and flips on its own — `firstHideNoticeShown` —
// is never written back over from a stale cached copy.
/** @template {MainQueryName} K @param {K} name @param {Partial<MainQueryValue[K]>} patch */
export function patchMain(name, patch) {
  const current = /** @type {MainQueryValue[K] | undefined} */ (entryFor(name).data)
  const merged = /** @type {MainQueryValue[K]} */ (Object.assign({}, current, patch))
  return writeMain(name, merged, { payload: patch })
}

// An out-of-band value: main PUSHES the zoom factor rather than answering a read, and a pushed
// value must land in the entry a read would fill or the two disagree. Bumps seq so an in-flight
// read cannot overwrite fresher pushed data.
/** @internal @template {MainQueryName} K @param {K} name @param {MainQueryValue[K] | undefined} data */
export function setMainData(name, data) {
  const entry = entryFor(name)
  entry.seq += 1
  entry.promise = null
  entry.data = data
  entry.error = null
  publish(entry)
}

/** @param {MainQueryName} name @param {() => void} notify */
export function subscribeMain(name, notify) {
  const entry = entryFor(name)
  entry.subscribers.add(notify)
  return () => { entry.subscribers.delete(notify) }
}

// Read during render, so it must not touch the map: React requires getSnapshot to be pure.
/** @template {MainQueryName} K @param {K} name @returns {Snapshot<MainQueryValue[K]>} */
export function peekMain(name) {
  return /** @type {Snapshot<MainQueryValue[K]>} */ (entries.get(name)?.snapshot ?? EMPTY_SNAPSHOT)
}

// ONE subscription per pushing fact for the whole app, installed at bootstrap — the main-store twin
// of installReconcileBridge(). Per-hook subscription would add a listener per mounted consumer.
export function installMainPushBridge() {
  /** @type {Array<() => void>} */
  const offs = []
  for (const name of /** @type {MainQueryName[]} */ (Object.keys(MAIN_QUERIES))) {
    const spec = MAIN_QUERIES[name]
    if (!spec.push || !bridge) continue
    const subscribe = bridge[spec.push]
    if (typeof subscribe !== 'function') continue
    offs.push(/** @type {(listener: (value: MainQueryValue[typeof name]) => void) => () => void} */ (subscribe.bind(bridge))((value) => setMainData(name, value)))
  }
  return () => { for (const off of offs) off() }
}

/** @internal */
export function resetMainStore() {
  entries.clear()
}
