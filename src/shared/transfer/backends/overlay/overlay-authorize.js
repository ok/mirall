// THE SERVE GATE decision, as a pure factory over its collaborators — NO bare/
// swarm imports, so the truth table unit-tests under brittle-node with fakes.
// overlay-instance.js wires in the real helpers: socket identity auth
// (senderAuthorizedOnSocket), membership (isApprovedMember), and the
// per-requester rate limiter.
//
// Deny is surfaced to the protocol as a silent drop — observationally
// identical to "I don't hold it", so a non-member learns nothing (no oracle).

/**
 * @param {object} deps
 * @param {{ get(peer): any }} deps.peerSocket overlay peer → swarm socket
 * @param {(socket, fromHex) => boolean} deps.senderAuthorizedOnSocket is this profile key Noise-authenticated on this socket?
 * @param {(spaceId, fromHex) => Promise<boolean>} deps.isApprovedMember approved-membership check for a space
 * @param {{ take(key): { ok: boolean } }} deps.serveLimiter per-requester serve rate limit
 * @param {{ spacesFor(hash): Iterable<string> }} deps.serveIndex
 * @returns {(peer, from, contentHash) => Promise<boolean>}
 */
export function makeServeAuthorizer({ peerSocket, senderAuthorizedOnSocket, isApprovedMember, serveLimiter, serveIndex }) {
  return async function authorizeServe(peer, from, contentHash) {
    const socket = peerSocket.get(peer)
    if (!socket) return false                                          // peer not attached on a live socket
    // 1) socket auth: the claimed profileKey must be Noise-authenticated on THIS socket.
    if (!from || !senderAuthorizedOnSocket(socket, from)) return false
    // 2) rate limit: per-requester serve budget, keyed on the asker identity.
    if (!serveLimiter.take(from).ok) return false
    // 3) membership: the asker must be an approved member of a space advertising this hash.
    for (const spaceId of serveIndex.spacesFor(contentHash)) {
      if (await isApprovedMember(spaceId, from)) return true
    }
    return false
  }
}
