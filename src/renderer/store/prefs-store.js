// Prefs are one main-process fact among several, so main-store.js owns the cache, the dedup and
// the write-through. This file stays as a named surface because usePrefs and two settings screens
// import it, and because "prefs" is a meaningful concept where 'main:prefs' is a key.
import { fetchMain, peekMain, resetMainStore, subscribeMain, writeMain } from './main-store.js'

const NAME = 'main:prefs'

// null, never undefined: usePrefs types prefs as AppPrefs | null and AppearanceSettings branches
// on it. The value itself, never a fresh object — useSyncExternalStore compares by identity.
export function peekPrefs () {
  return peekMain(NAME).data ?? null
}

export function subscribePrefs (notify) {
  return subscribeMain(NAME, notify)
}

export function loadPrefs () {
  return fetchMain(NAME)
}

// A PATCH where writeMain is a REPLACE. Prefs is the only fact with patch semantics; merging here
// rather than in the store keeps the store's contract single-meaning. Collapsing this into
// writeMain(NAME, patch) would drop every pref the caller did not name.
export function writePrefs (patch) {
  const current = peekMain(NAME).data
  return writeMain(NAME, current ? { ...current, ...patch } : { ...patch })
}

// A test hook. It clears the whole main store, not just the prefs entry, because the old
// prefs-only reset also dropped its subscribers and a per-entry clear would not.
export function resetPrefsStore () {
  resetMainStore()
}
