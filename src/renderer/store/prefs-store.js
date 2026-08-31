// One shared copy of main's app prefs, for the settings screens that read them.
//
// Deliberately NOT the query store: useQuery is typed to RequestName — the WORKER contract — and
// prefs:get/prefs:set are Electron MAIN calls (preload.js). Routing them through it would mean
// either widening RequestName to a lie or adding an untyped escape hatch. This is the query
// store's shape with none of its scope/invalidation machinery, because prefs change only when
// this app writes them — there is no hint to consume. If that ever stops being true, this store
// needs an event and the screens need to stop assuming their own write is the only one.
//
// Plain JS with an injected transport so it unit-tests under brittle-node, like query-store.js.
let cache = null
let inFlight = null
const subscribers = new Set()

let bridge = {
  getPrefs: () => Promise.reject(new Error('prefs store: no transport configured')),
  setPrefs: () => Promise.reject(new Error('prefs store: no transport configured')),
}

export function configurePrefsStore ({ getPrefs, setPrefs }) {
  bridge = { getPrefs, setPrefs }
}

function publish (next) {
  cache = next
  for (const notify of subscribers) notify()
}

// The value itself, never a fresh object: useSyncExternalStore compares snapshots by identity, so
// an allocating getSnapshot warns in DEV and can loop forever.
export function peekPrefs () {
  return cache
}

export function subscribePrefs (notify) {
  subscribers.add(notify)
  return () => { subscribers.delete(notify) }
}

// The dedup: settings screens mounting in one session each issued their own prefs:get and each
// kept a private copy in component state, which could disagree with the other after a write.
export function loadPrefs () {
  if (cache !== null) return Promise.resolve(cache)
  if (inFlight) return inFlight
  inFlight = bridge.getPrefs()
    .then((p) => { publish(p); return p })
    .finally(() => { inFlight = null })
  return inFlight
}

// Optimistic, then authoritative — the shape both screens already used, but now visible to every
// screen at once instead of only the one that issued the write.
export async function writePrefs (patch) {
  if (cache) publish({ ...cache, ...patch })
  publish(await bridge.setPrefs(patch))
}

export function resetPrefsStore () {
  cache = null
  inFlight = null
  subscribers.clear()
}
