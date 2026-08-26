// Folds per-peer presence flapping into at most one row per real absence.
//
// The floor is much higher than the device hold-down because a peer reconnect is routine: an app
// restart, a mux re-dial, a lid closing for a meeting. "Anna was gone for six minutes" is worth a
// row; "Anna's socket blipped" is not. A `peer_back` row is written ONLY when a `peer_lost` row was
// written for that pair, so a peer flapping below the floor produces nothing at all — never a lone
// "is back online" closing an absence the reader never saw.
//
// Nothing here is persisted, deliberately: after OUR OWN restart every peer is "disconnected", and
// we cannot distinguish "they left while we were down" from "we were down". An open absence dies
// with the process.

export const PEER_DWELL_MS = 300000
const PEER_CAP_WINDOW_MS = 86400000
const PEER_CAP = 12
// A recorded absence stays open so the return can close it. A peer that never comes back would
// otherwise pin one entry forever, so an absence this old is forgotten — the cost is no
// "is back online" row for a peer returning after a week, which is the right thing to lose.
const PEER_STALE_MS = 604800000

export const KIND_PEER_LOST = 'network.peer_lost'
export const KIND_PEER_BACK = 'network.peer_back'

export function peerKeyOf(publicKey, spaceId) {
  return publicKey + '|' + spaceId
}

export function createPeerPresenceTracker({
  dwellMs = PEER_DWELL_MS,
  cap = PEER_CAP,
  capWindowMs = PEER_CAP_WINDOW_MS,
  staleMs = PEER_STALE_MS,
} = {}) {
  const open = new Map()
  const recent = new Map()

  // `meta` is a snapshot taken now, because the row has to render once the roster is gone — the
  // same zero-joins rule the record itself follows.
  function lost(publicKey, spaceId, { now, meta = null }) {
    const key = peerKeyOf(publicKey, spaceId)
    // A second loss without an intervening `seen` is the same absence (a departure frame followed
    // by the socket close). Keep the first timestamp.
    if (open.has(key)) return
    open.set(key, { publicKey, spaceId, lostAt: now, meta, recorded: false })
  }

  function seen(publicKey, spaceId, { now }) {
    const key = peerKeyOf(publicKey, spaceId)
    const episode = open.get(key)
    if (!episode) return null
    open.delete(key)
    if (!episode.recorded) return null
    return {
      kind: KIND_PEER_BACK,
      publicKey,
      spaceId,
      meta: episode.meta,
      subject: { durationMs: Math.max(0, now - episode.lostAt) },
    }
  }

  // The space name is resolved asynchronously by the caller, but the episode must be captured
  // synchronously or a reconnect can overtake the loss — so the name lands afterwards.
  function annotate(publicKey, spaceId, patch) {
    const episode = open.get(peerKeyOf(publicKey, spaceId))
    if (episode && !episode.recorded) episode.meta = { ...episode.meta, ...patch }
  }

  // Drop an absence WITHOUT a row: the peer left the space (member.left tells that story), our own
  // connectivity went bad (every peer looks gone, and the device row says why), or we are shutting
  // down. Omit both ids to abandon everything.
  function abandon(publicKey = null, spaceId = null) {
    if (publicKey === null) { open.clear(); return }
    if (spaceId !== null) { open.delete(peerKeyOf(publicKey, spaceId)); return }
    for (const [key, episode] of open) if (episode.publicKey === publicKey) open.delete(key)
  }

  // Returns 'record' | 'suppress-first' | 'suppress'. The marker fires only on the transition into
  // the capped state: audit-log.js exempts audit.suppressed from its own rate guard, so emitting one
  // per over-cap absence would bound nothing at all — the cap has to collapse them here.
  function admission(key, now) {
    const entry = recent.get(key) || { stamps: [], marked: false }
    entry.stamps = entry.stamps.filter((at) => now - at < capWindowMs)
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

  function forget(now) {
    for (const [key, episode] of open) {
      if (episode.recorded && now - episode.lostAt > staleMs) open.delete(key)
    }
    for (const [key, entry] of recent) {
      if (!entry.stamps.some((at) => now - at < capWindowMs) && !entry.marked) recent.delete(key)
    }
  }

  // Past the cap the tracker emits a marker rather than dropping silently — a gap the reader cannot
  // see is worse than a visible one, the same call audit-log.js's rate guard makes.
  function step(now) {
    const rows = []
    let nextDue = null
    forget(now)
    for (const [key, episode] of open) {
      if (episode.recorded) continue
      const due = episode.lostAt + dwellMs
      if (now < due) {
        nextDue = nextDue === null ? due : Math.min(nextDue, due)
        continue
      }
      const verdict = admission(key, now)
      if (verdict !== 'record') {
        // Dropped, not flagged recorded: a suppressed absence the reader never saw must not later
        // emit a lone "is back online" closing it.
        open.delete(key)
        if (verdict === 'suppress-first') {
          rows.push({
            suppressed: true,
            kind: KIND_PEER_LOST,
            publicKey: episode.publicKey,
            spaceId: episode.spaceId,
            meta: episode.meta,
            cap,
            windowMs: capWindowMs,
          })
        }
        continue
      }
      episode.recorded = true
      rows.push({
        kind: KIND_PEER_LOST,
        publicKey: episode.publicKey,
        spaceId: episode.spaceId,
        meta: episode.meta,
        subject: { sinceTs: episode.lostAt },
      })
    }
    return { rows, waitMs: nextDue === null ? null : Math.max(0, nextDue - now) }
  }

  return {
    lost,
    seen,
    annotate,
    abandon,
    step,
    reset: () => { open.clear(); recent.clear() },
    size: () => open.size,
  }
}
