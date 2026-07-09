// Level-triggered retry ledger for per-(connection, space) identity-frame announcements.
// swarm.js records every handshake / membership:request it sends; the convergence tick asks
// what is DUE for a re-send. An announcement stays here until its implicit ack lands
// (injected as isSettled: a peer on that socket is admitted for the space, or the pending
// space's grant/deny arrived), so a frame the receiver dropped self-heals without a
// reconnect. kind 'handshake' gives up after maxAttempts — the peer likely doesn't share
// the space; kind 'request' never gives up and decays to a capped heartbeat instead,
// because the request frame is the only thing that can surface the approval banner.
export function createAnnounceLedger () {
  const bySocket = new Map()
  return {
    recordSend (socketId, spaceId, kind, now) {
      if (!bySocket.has(socketId)) bySocket.set(socketId, new Map())
      const m = bySocket.get(socketId)
      const e = m.get(spaceId)
      m.set(spaceId, { kind, attempts: (e?.attempts || 0) + 1, lastAt: now })
    },
    forgetSocket (socketId) { bySocket.delete(socketId) },
    clear () { bySocket.clear() },
    lastSentAt (socketId, spaceId) { return bySocket.get(socketId)?.get(spaceId)?.lastAt ?? 0 },
    // The distinct spaceIds present across all sockets, so a caller can resolve per-space
    // context (status) only for spaces actually pending, not every joined space.
    spaceIds () {
      const out = new Set()
      for (const m of bySocket.values()) for (const spaceId of m.keys()) out.add(spaceId)
      return out
    },
    due ({ now, baseMs, capMs, maxAttempts, isSettled }) {
      const out = []
      for (const [socketId, m] of bySocket) {
        for (const [spaceId, e] of m) {
          // Prune settled entries, and a handshake that exhausted its attempts (the peer
          // likely doesn't share the space) — both so the socket bucket can evaporate.
          if (isSettled(socketId, spaceId, e.kind) ||
              (e.kind === 'handshake' && e.attempts >= maxAttempts)) { m.delete(spaceId); continue }
          const wait = Math.min(capMs, baseMs * 2 ** Math.max(0, e.attempts - 1))
          if (now - e.lastAt >= wait) out.push({ socketId, spaceId, kind: e.kind })
        }
        if (m.size === 0) bySocket.delete(socketId)
      }
      return out
    },
  }
}

// The status a space contributes to the re-announce settle decision. A PRESENT space with no
// status field (owner-created and v1 spaces carry none) is 'active' — a normal member space we
// must keep re-announcing for — NOT settled; only a genuinely-absent space (getSpace null) is
// null. Conflating "statusless but present" with "gone" silently killed the owner's re-announce.
export function announceStatus (space) {
  return space ? (space.status || 'active') : null
}

// Escalation throttle for the convergence tick: refresh a space's discovery only once its
// roster deficit persisted escalateTicks consecutive ticks AND the previous refresh is at
// least minMs old — a stalled stream gets one restart-equivalent kick per window, not a storm.
export function escalationDue ({ ticks, escalateTicks, lastRefreshAt, minMs, now }) {
  return ticks >= escalateTicks && now - lastRefreshAt >= minMs
}
