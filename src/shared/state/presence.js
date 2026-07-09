// Ephemeral presence: a peer is "online" in a space while its self-reported lease is
// fresh. Leases are refreshed by heartbeats and expire on their own — SWIM-lite failure
// detection — so no reliable "I'm gone" message is needed. In-memory, never persisted,
// never reconciled (the opposite of membership, which is durable, log-backed state).
//
// Marked on handshake (instant online) and cleared on disconnect (instant offline); the TTL
// is the backstop that catches a peer whose socket lingers but who has gone silent. The
// receiver controls the TTL (ignores any sender-claimed expiry), so a peer can't extend its
// own lease — it's online only for `ttl` after the LAST heartbeat we actually received.
//
// `now` is injectable for tests.

export function createPresence ({ ttl = 15000, now = () => Date.now(), onExpire = () => {} } = {}) {
  const leases = new Map()   // peerKey -> Map<spaceId, expiry>

  // Returns true when this mark flipped the peer online (fresh lease or an expired
  // lease being restored) — the caller mirrors the onExpire emit for that transition.
  function mark (peerKey, spaceId) {
    let spaces = leases.get(peerKey)
    if (!spaces) { spaces = new Map(); leases.set(peerKey, spaces) }
    const exp = spaces.get(spaceId)
    const wasLive = exp != null && now() < exp
    spaces.set(spaceId, now() + ttl)
    return !wasLive
  }

  function isOnline (peerKey, spaceId) {
    const exp = leases.get(peerKey)?.get(spaceId)
    return exp != null && now() < exp
  }

  // Online anywhere (any space) — for "is this peer reachable at all" checks.
  function isOnlineAnywhere (peerKey) {
    const spaces = leases.get(peerKey)
    if (!spaces) return false
    const t = now()
    for (const exp of spaces.values()) if (t < exp) return true
    return false
  }

  function onlineIn (spaceId) {
    const out = new Set()
    const t = now()
    for (const [peerKey, spaces] of leases) {
      const exp = spaces.get(spaceId)
      if (exp != null && t < exp) out.add(peerKey)
    }
    return out
  }

  // Drop a peer's lease(s). spaceId omitted ⇒ everywhere (used on disconnect). Returns true when
  // this dropped a live (unexpired) lease — a real online→offline flip the caller can gate on
  // (mirror of mark's flip return), so repeated/late clears don't re-emit.
  function clear (peerKey, spaceId) {
    const spaces = leases.get(peerKey)
    if (!spaces) return false
    if (spaceId == null) { leases.delete(peerKey); return true }
    const exp = spaces.get(spaceId)
    const wasLive = exp != null && now() < exp
    spaces.delete(spaceId)
    if (spaces.size === 0) leases.delete(peerKey)
    return wasLive
  }

  // Housekeeping: drop expired leases so the map doesn't grow with churned peers. Each expiry is a
  // silent-death offline transition (the socket lingered but the peer went quiet), so fire onExpire
  // — the caller re-emits a reconcile hint, otherwise the UI would show the peer online until an
  // unrelated refresh (the "expiry never re-emits" seam).
  function prune () {
    const t = now()
    for (const [peerKey, spaces] of leases) {
      for (const [spaceId, exp] of spaces) if (t >= exp) { spaces.delete(spaceId); onExpire(peerKey, spaceId) }
      if (spaces.size === 0) leases.delete(peerKey)
    }
  }

  function clearAll () { leases.clear() }

  return { mark, isOnline, isOnlineAnywhere, onlineIn, clear, prune, clearAll }
}

// Classify an inbound presence frame by shape alone (no swarm state): a well-formed frame with
// offline:true is a graceful-quit departure → 'clear'; a well-formed heartbeat → 'mark'; anything
// malformed → 'ignore'. The caller still applies the anti-spoof guard + spaceId resolution.
export function presenceFrameKind (msg) {
  if (!msg || typeof msg.profileKey !== 'string' || typeof msg.spaceTopic !== 'string') return 'ignore'
  return msg.offline === true ? 'clear' : 'mark'
}
