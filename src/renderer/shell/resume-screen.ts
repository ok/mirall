// Where to land after the renderer reloads itself. Applying a relay restarts the worker, and the
// renderer reloads to re-establish its subscriptions — which also takes the screen graph back to
// its root, dropping the user on the space list with nothing to see and several steps back to the
// setting they were just on. The screen is parked in session storage: it survives the reload and
// dies with the window, so it never becomes a stored preference.
//
// Only the screens listed here can be resumed. The value comes back out of storage, so anything
// else would be an unvalidated screen name deciding what the app renders on boot.
const RESUMABLE = ['network-settings'] as const

export type ResumableScreen = typeof RESUMABLE[number]

const KEY = 'mirall:resume-screen'

export function rememberScreen(screen: ResumableScreen): void {
  // Storage can be unavailable or full; boot at the root rather than fail the reconnect.
  try { sessionStorage.setItem(KEY, screen) } catch { /* no resume, no harm */ }
}

// Reads AND clears: the parked screen belongs to the next boot only. Leaving it behind would send
// a later restart — an OTA apply, a crash recovery — to a screen nobody asked for.
export function takeRememberedScreen(): ResumableScreen | null {
  let value: string | null = null
  try {
    value = sessionStorage.getItem(KEY)
    sessionStorage.removeItem(KEY)
  } catch {
    return null
  }
  return RESUMABLE.includes(value as ResumableScreen) ? value as ResumableScreen : null
}
