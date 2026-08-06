// Folds a byte-moving activity that has a start and an end into ONE audit row. Without this a
// single file transfer would emit a row per chunk, and a peer whose connection flaps would emit
// one per reconnect.
//
// Pure and clock-injected: `now` is passed in by the caller, so the elapsed-time arithmetic is
// deterministic under test.
//
// A re-open of a key that is still within `joinWindowMs` of its last activity is treated as a
// RESUME of the open session rather than a new one — that is what collapses a flapping peer's
// 50 reconnects into a single served-file row.

export const DEFAULT_JOIN_WINDOW_MS = 120000

export function createSessionStore({ joinWindowMs = DEFAULT_JOIN_WINDOW_MS } = {}) {
  const open = new Map()

  function start(key, { now, meta = null, total = 0 }) {
    const existing = open.get(key)
    if (existing && now - existing.lastAt <= joinWindowMs) {
      existing.lastAt = now
      if (meta) existing.meta = { ...existing.meta, ...meta }
      if (total > existing.total) existing.total = total
      existing.resumes += 1
      return existing
    }
    const session = { key, startedAt: now, lastAt: now, bytes: 0, total, meta, resumes: 0 }
    open.set(key, session)
    return session
  }

  // Callers that see a cumulative figure use progress(); callers fed per-chunk deltas use
  // advance(), so neither has to reach into the session object itself.
  function advance(key, { now, delta }) {
    const session = open.get(key)
    if (!session) return null
    session.lastAt = now
    if (Number.isFinite(delta) && delta > 0) session.bytes += delta
    return session
  }

  function progress(key, { now, bytes }) {
    const session = open.get(key)
    if (!session) return null
    session.lastAt = now
    if (Number.isFinite(bytes) && bytes > session.bytes) session.bytes = bytes
    return session
  }

  // Returns the finished session, or null when there was nothing open — callers must tolerate
  // an end without a start (a serve can be torn down before it ever produced bytes).
  function end(key, { now, bytes = null }) {
    const session = open.get(key)
    if (!session) return null
    open.delete(key)
    if (Number.isFinite(bytes) && bytes > session.bytes) session.bytes = bytes
    return {
      ...session,
      endedAt: now,
      durationMs: Math.max(0, now - session.startedAt),
    }
  }

  // Sessions whose peer vanished without an end frame would otherwise pin memory forever.
  function reap(now, maxAgeMs) {
    const dropped = []
    for (const [key, session] of open) {
      if (now - session.lastAt > maxAgeMs) {
        open.delete(key)
        dropped.push({ ...session, endedAt: session.lastAt, durationMs: Math.max(0, session.lastAt - session.startedAt) })
      }
    }
    return dropped
  }

  function clear() { open.clear() }

  return { start, progress, advance, end, reap, clear, size: () => open.size, has: (key) => open.has(key) }
}

export function sessionKey(...parts) {
  return parts.map((p) => p || '').join('\0')
}
