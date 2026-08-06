// THE SERVE GATE decision, as a pure factory over its collaborators — NO bare/
// swarm imports, so the truth table unit-tests under brittle-node with fakes.
// overlay-instance.js wires in the real helpers: socket identity auth
// (socketAuthorized — control or content plane), membership (isApprovedMember),
// and the per-requester rate limiter.
//
// Deny is surfaced to the protocol as a silent drop — observationally
// identical to "I don't hold it", so a non-member learns nothing (no oracle).

/**
 * @param {object} deps
 * @param {{ get(peer): any }} deps.peerSocket overlay peer → swarm socket
 * @param {(socket, fromHex) => boolean} deps.socketAuthorized is this profile key Noise-authenticated on this socket?
 * @param {(spaceId, fromHex) => Promise<boolean>} deps.isApprovedMember approved-membership check for a space
 * @param {{ take(key): { ok: boolean } }} deps.serveLimiter per-requester serve rate limit
 * @param {{ spacesFor(hash): Iterable<string> }} deps.serveIndex
 * @returns {(peer, from, contentHash, opts?: { rateLimit?: boolean }) => Promise<boolean>}
 */
// Denial reasons. Only UNAUTHENTICATED and NOT_A_MEMBER mean "access refused"; the other two are
// ordinary operation — NO_SOCKET is a teardown race, and RATE_LIMITED is flow control that fires
// routinely mid-transfer when a peer asks for chunks faster than the budget allows. Conflating
// them makes a busy mirror look like a stream of security incidents.
export const DENY = {
  NO_SOCKET: 'no-socket',
  UNAUTHENTICATED: 'unauthenticated',
  RATE_LIMITED: 'rate-limited',
  NOT_A_MEMBER: 'not-a-member',
}

export const SECURITY_DENIALS = new Set([DENY.UNAUTHENTICATED, DENY.NOT_A_MEMBER])

export function makeServeAuthorizer({ peerSocket, socketAuthorized, isApprovedMember, serveLimiter, serveIndex, onDeny = null }) {
  return async function authorizeServe(peer, from, contentHash, { rateLimit = true } = {}) {
    const deny = (reason) => {
      if (onDeny) { try { onDeny(reason, { peer, from, contentHash }) } catch { /* never break the gate */ } }
      return false
    }
    const socket = peerSocket.get(peer)
    if (!socket) return deny(DENY.NO_SOCKET)                           // peer not attached on a live socket
    // 1) socket auth: the claimed profileKey must be Noise-authenticated on THIS socket.
    if (!from || !socketAuthorized(socket, from)) return deny(DENY.UNAUTHENTICATED)
    // 2) rate limit: per-requester serve budget, keyed on the asker identity. Skipped when we
    //    re-validate a grant WE already issued (an epoch bump, not an inbound request) — charging
    //    that to the asker's budget would revoke healthy transfers for being numerous.
    if (rateLimit && !serveLimiter.take(from).ok) return deny(DENY.RATE_LIMITED)
    // 3) membership: the asker must be an approved member of a space advertising this hash.
    for (const spaceId of serveIndex.spacesFor(contentHash)) {
      if (await isApprovedMember(spaceId, from)) return true
    }
    return deny(DENY.NOT_A_MEMBER)
  }
}
