// Per-key scheduler for peer-bee captures: single-flight, throttled, and re-armed when
// the peer's core grew past what we captured. Pure factory — capture/coreLength are
// injected (profile.js wires the real ones in member-registry), so the policy is
// unit-testable without a store.
export function makeCaptureScheduler({ capture, coreLength, retryMinMs = 30_000, now = Date.now, onError = () => {} }) {
  const state = new Map()

  // Growth is measured against the length SEEN by the last capture attempt (not the
  // contiguous progress): an incomplete capture is throttled like any other retry,
  // while a genuinely appended core bypasses the window.
  const grew = (key, s) => s.seenLength != null && s.knownLength > s.seenLength

  // A `capped` bee is as captured as it will ever be (its tail is past the sweep budget),
  // so it retires like a complete one instead of retrying forever.
  const settled = (s) => s.complete || s.capped

  function schedule(key) {
    let s = state.get(key)
    if (!s) {
      s = { inFlight: false, attempted: false, lastAt: 0, seenLength: null, knownLength: 0, complete: false, capped: false }
      state.set(key, s)
    }
    if (s.inFlight) return false
    if (settled(s) && !grew(key, s)) return false
    if (s.attempted && now() - s.lastAt < retryMinMs && !grew(key, s)) return false
    s.inFlight = true
    s.attempted = true
    s.lastAt = now()
    Promise.resolve()
      .then(() => capture(key))
      .then((r) => {
        s.complete = !!r?.complete
        s.capped = !!r?.capped
        s.seenLength = r?.length ?? s.seenLength
      })
      .catch((err) => onError(key, err))
      .finally(() => { s.inFlight = false })
    return true
  }

  // Refresh each tracked key's known length, then report the keys worth re-capturing.
  // Async because reading a peer core's length opens (and closes) a session.
  async function incomplete() {
    const out = []
    for (const [key, s] of state) {
      if (s.inFlight) continue
      try { s.knownLength = await coreLength(key) } catch { /* keep the last known length */ }
      if (!settled(s) || grew(key, s)) out.push(key)
    }
    return out
  }

  function forget(key) {
    state.delete(key)
  }

  function clear() {
    state.clear()
  }

  return { schedule, incomplete, forget, clear }
}
