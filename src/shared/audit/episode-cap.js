// A per-key cap on recorded episodes in a sliding window, shared by the presence and relay
// trackers. Past the cap it answers 'suppress-first' once, on the transition into the capped
// state, and 'suppress' after that: audit-log.js exempts audit.suppressed from its own rate guard,
// so a marker per over-cap episode would bound nothing — the cap has to collapse them here.

export function createEpisodeCap({ cap, windowMs }) {
  const recent = new Map()

  function admit(key, now) {
    const entry = recent.get(key) || { stamps: [], marked: false }
    entry.stamps = entry.stamps.filter((at) => now - at < windowMs)
    if (entry.stamps.length >= cap) {
      const first = !entry.marked
      entry.marked = true
      recent.set(key, entry)
      return first ? 'suppress-first' : 'suppress'
    }
    entry.marked = false
    entry.stamps.push(now)
    recent.set(key, entry)
    return 'record'
  }

  // Undoes the key's last admission: a row the log refused must not count against the cap, and a
  // marker it refused must be offered again on the next transition.
  function refund(key) {
    const entry = recent.get(key)
    if (!entry) return
    if (entry.marked) entry.marked = false
    else entry.stamps.pop()
  }

  function forget(now) {
    for (const [key, entry] of recent) {
      if (!entry.stamps.some((at) => now - at < windowMs)) recent.delete(key)
    }
  }

  return { admit, refund, forget, reset: () => recent.clear() }
}
