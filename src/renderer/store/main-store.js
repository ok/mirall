import { MAIN_QUERIES } from './main-queries.js'

// One shared copy per main-process fact, for the screens that read them.
//
// Deliberately NOT the query store: useQuery is typed to RequestName — the WORKER contract — and
// these are Electron MAIN calls (preload.js). Routing them through it would mean either widening
// RequestName to a lie or adding an untyped escape hatch. This is the query store's shape with
// none of its scope/invalidation machinery: a main fact changes when THIS app writes it, or when
// main pushes a new value, and neither is a reconcile hint.
//
// No abort, unlike the query store: ipcRenderer.invoke has no cancellation channel, and these
// reads are local. `seq` still exists, because "the answer in flight is no longer wanted" is a
// real state here too — a write or a push can land while a read is outstanding.
//
// Plain JS with an injected bridge so it unit-tests under brittle-node, like query-store.js.
const entries = new Map()

let bridge = null

export function configureMainStore (b) {
  bridge = b
}

const EMPTY_SNAPSHOT = Object.freeze({ data: undefined, error: null, loading: true })

function entryFor (name) {
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
function snapshotOf (entry) {
  const settled = entry.data !== undefined || entry.error !== null
  return { data: entry.data, error: entry.error, loading: entry.promise !== null || !settled }
}

// Keeps the SAME object when nothing changed: useSyncExternalStore compares by identity, so a
// structurally identical fresh snapshot would re-render every subscriber for nothing.
function publish (entry) {
  const next = snapshotOf(entry)
  const prev = entry.snapshot
  if (prev && prev.data === next.data && prev.error === next.error && prev.loading === next.loading) return
  entry.snapshot = next
  for (const notify of entry.subscribers) notify()
}

function specFor (name) {
  const spec = MAIN_QUERIES[name]
  if (!spec) throw new Error(`main store: unknown fact "${name}"`)
  if (!bridge) throw new Error('main store: no bridge configured')
  return spec
}

// The dedup and the cache: two screens mounting in one session each issued their own read and each
// kept a private copy in component state, which could disagree with the other after a write. A
// settled fact answers from the entry, so a remounting modal costs no round-trip at all.
export function fetchMain (name) {
  let spec
  try {
    spec = specFor(name)
  } catch (err) {
    return Promise.reject(err)
  }

  const entry = entryFor(name)
  if (entry.promise) return entry.promise
  if (entry.data !== undefined) return Promise.resolve(entry.data)

  const seq = ++entry.seq
  const inFlight = spec.read(bridge)
    .then(
      (data) => {
        // A write or a push that landed while this read was out has already published a FRESHER
        // value. Resolving with the entry's value rather than the stale one mirrors the query
        // store: a superseded read is not an error the caller asked about.
        if (seq !== entry.seq) return entry.data
        entry.data = data
        entry.error = null
        entry.promise = null
        publish(entry)
        return data
      },
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
export async function writeMain (name, value) {
  const spec = specFor(name)
  const entry = entryFor(name)
  const previous = entry.data

  entry.seq += 1
  entry.promise = null
  entry.data = value
  entry.error = null
  publish(entry)

  try {
    const persisted = await spec.write(bridge, value)
    entry.seq += 1
    entry.data = persisted
    publish(entry)
    return persisted
  } catch (err) {
    entry.seq += 1
    entry.data = previous
    entry.error = err
    publish(entry)
    throw err
  }
}

// An out-of-band value: main PUSHES the zoom factor rather than answering a read, and a pushed
// value must land in the entry a read would fill or the two disagree. Bumps seq so an in-flight
// read cannot overwrite fresher pushed data.
export function setMainData (name, data) {
  const entry = entryFor(name)
  entry.seq += 1
  entry.promise = null
  entry.data = data
  entry.error = null
  publish(entry)
}

export function subscribeMain (name, notify) {
  const entry = entryFor(name)
  entry.subscribers.add(notify)
  return () => { entry.subscribers.delete(notify) }
}

// Read during render, so it must not touch the map: React requires getSnapshot to be pure.
export function peekMain (name) {
  return entries.get(name)?.snapshot ?? EMPTY_SNAPSHOT
}

// ONE subscription per pushing fact for the whole app, installed at bootstrap — the main-store twin
// of installReconcileBridge(). Per-hook subscription would add a listener per mounted consumer.
export function installMainPushBridge () {
  const offs = []
  for (const [name, spec] of Object.entries(MAIN_QUERIES)) {
    if (!spec.push) continue
    const subscribe = bridge?.[spec.push]
    if (typeof subscribe !== 'function') continue
    offs.push(subscribe.call(bridge, (value) => setMainData(name, value)))
  }
  return () => { for (const off of offs) off() }
}

export function resetMainStore () {
  entries.clear()
}
