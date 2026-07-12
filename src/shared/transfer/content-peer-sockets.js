// Which authenticated identities ride which content socket.
//
// Extracted from content-swarm so the teardown rule is testable without a live swarm: "drop the
// sockets this peer is authenticated on, leave every other socket alone". Both ways of getting it
// wrong are costly — too lax and we keep streaming a space's bytes to a peer that left it; too
// eager and we kill a healthy transfer for a peer we still share another space with.
//
// A socket can carry more than one identity (a peer may authenticate several profiles on it), so
// the map is socket → Set<profileKey>.
export function createContentPeerSockets() {
  const socketToPeers = new Map()

  return {
    add(socket, profileKeyHex) {
      let set = socketToPeers.get(socket)
      if (!set) { set = new Set(); socketToPeers.set(socket, set) }
      set.add(profileKeyHex)
    },

    forget(socket) {
      socketToPeers.delete(socket)
    },

    authorized(socket, profileKeyHex) {
      return !!socketToPeers.get(socket)?.has(profileKeyHex)
    },

    // Is this peer reachable on ANY live content socket? Distinct from authorized(), which asks
    // about one socket: this is the "can the bulk plane still talk to them at all" question.
    hasPeer(profileKeyHex) {
      for (const keys of socketToPeers.values()) if (keys.has(profileKeyHex)) return true
      return false
    },

    // Destroy every socket this profile is authenticated on. Returns how many were dropped.
    destroyFor(profileKeyHex) {
      let dropped = 0
      for (const [socket, keys] of socketToPeers) {
        if (!keys.has(profileKeyHex)) continue
        try { socket.destroy() } catch {}
        socketToPeers.delete(socket) // the socket's own 'close' also clears it; do it here in case destroy() throws
        dropped++
      }
      return dropped
    },

    clear() {
      socketToPeers.clear()
    },

    get size() {
      return socketToPeers.size
    },
  }
}
