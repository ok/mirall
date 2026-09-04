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

// A PATCH where writeMain is a REPLACE. Prefs is the only fact with patch semantics.
//
// The merge is what we DISPLAY (so a screen keeps the prefs it already showed while the write is
// in flight); the bare patch is what main is SENT. Main merges it into its own copy and returns
// the whole record, which then replaces ours.
//
// Sending our merged record instead would clobber keys main owns: `main:prefs` has no push
// channel, and main flips `firstHideNoticeShown` on its own when it first hides to the tray. Our
// cached copy still reads `false`, so the next unrelated toggle wrote that `false` back over
// main's `true` — and the tray notice fired a second time.
export function writePrefs (patch) {
  const current = peekMain(NAME).data
  return writeMain(NAME, current ? { ...current, ...patch } : { ...patch }, { payload: patch })
}

// A test hook. It clears the whole main store, not just the prefs entry, because the old
// prefs-only reset also dropped its subscribers and a per-entry clear would not.
export function resetPrefsStore () {
  resetMainStore()
}
