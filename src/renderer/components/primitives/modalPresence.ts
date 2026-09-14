import { useEffect, useSyncExternalStore } from 'react'

let openCount = 0
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

// Registers a dialog as on screen for as long as it is mounted. Modal calls it, so nothing else has
// to know which dialogs exist.
export function useModalPresence(): void {
  useEffect(() => {
    openCount++
    emit()
    return () => { openCount--; emit() }
  }, [])
}

// Whether any dialog is on screen.
//
// Back navigation asks this. A dialog sits in front of the screen, so backing out from under one
// leaves the user on a different screen with a dialog they never dismissed. The alternative is a
// hand-written list of dialog flags, which is what this replaces: it knew about three and missed
// the eight the space screen holds, because a list like that is only ever as current as the last
// dialog someone remembered to add to it.
export function useAnyModalOpen(): boolean {
  return useSyncExternalStore(subscribe, () => openCount > 0, () => false)
}
