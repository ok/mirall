// The serve side's file descriptors: one per (peer, disk path), read with positioned async reads,
// swept when idle, bounded per peer, and released when the peer closes.
//
// Keyed by disk path per peer, not per grant: one file can be granted under more than one
// synthetic path. The fd number is never carried across an await — it is read from the entry right
// before a read is issued, and every close deletes the entry before closing — so a reused
// descriptor number can never be mistaken for a live one. `busy` keeps the sweep off an entry
// whose read is in flight.

// A source is closed after this long without a read. Bounds how long a handle is held on the
// user's file after a peer finishes or stalls (on Windows a held handle defers the file's
// deletion); a loop parked on the upload cap or on backpressure simply re-opens on its next chunk.
const SERVE_FD_IDLE_MS = 30000
const SERVE_FD_SWEEP_MS = 15000
// A peer mirroring a large folder touches thousands of files inside one idle window, so time
// alone does not bound the handle count. Past this many open sources for one peer the least
// recently opened idle handle is closed; EMFILE would otherwise surface as skipped chunks.
const SERVE_FD_MAX_PER_PEER = 64

export class ServeFds {
  // `reads` opens, reads and closes sources (TransferManager). `peers` lists the attached peers.
  constructor({ reads, peers, idleMs = SERVE_FD_IDLE_MS }) {
    this._reads = reads
    this._peers = peers
    this._idleMs = idleMs
    this._byPeer = new WeakMap()
    // Floored: idleMs 0 ("close immediately") would otherwise spin a 0 ms interval. Unref'd: with
    // nothing served there is nothing to sweep, and stop() clears it.
    this._sweep = setInterval(() => this.sweep(), Math.max(50, Math.min(SERVE_FD_SWEEP_MS, idleMs)))
    this._sweep.unref?.()
  }

  async read(peer, diskPath, chunk) {
    let fds = this._byPeer.get(peer)
    if (!fds) { fds = new Map(); this._byPeer.set(peer, fds) }
    let src = fds.get(diskPath)
    if (!src) {
      const fd = await this._reads.openChunkSource(diskPath)
      if (fd === null || fd === undefined) return null
      // Across that await the channel may have closed (closePeer already swept the map, so an fd
      // stored now would leak) or a sibling loop may have opened the same file first.
      fds = this._byPeer.get(peer)
      src = fds?.get(diskPath)
      if (peer.channel?.closed || src || !fds) {
        this._drop(fd)
        if (!src) return null
      } else {
        src = { fd, lastAt: 0, busy: 0, pendingClose: false }
        fds.set(diskPath, src)
        this.trim(peer)
      }
    }
    src.lastAt = Date.now()
    src.busy++
    try {
      return await this._reads.readChunkAt(src.fd, chunk.offset, chunk.length)
    } finally {
      src.busy--
      // A close that arrived mid-read deferred to this read: the descriptor is only safe to
      // release once no read holds it, or a concurrent open could reuse the number underneath
      // readChunkAt's partial-read loop.
      if (src.pendingClose && !src.busy) this._drop(src.fd)
    }
  }

  closePeer(peer) {
    const fds = this._byPeer.get(peer)
    if (!fds) return
    for (const [diskPath, src] of fds) this._close(fds, diskPath, src)
    this._byPeer.delete(peer)
  }

  sweep() {
    const now = Date.now()
    for (const peer of this._peers()) {
      const fds = this._byPeer.get(peer)
      if (!fds) continue
      for (const [diskPath, src] of fds) {
        if (!src.busy && now - src.lastAt > this._idleMs) this._close(fds, diskPath, src)
      }
    }
  }

  stop() { clearInterval(this._sweep) }

  // Only idle entries are eligible; a busy one is left for the next pass (its own read releases it
  // if a close is pending).
  /** @internal */
  trim(peer) {
    const fds = this._byPeer.get(peer)
    if (!fds || fds.size <= SERVE_FD_MAX_PER_PEER) return
    for (const [diskPath, src] of fds) {
      if (fds.size <= SERVE_FD_MAX_PER_PEER) return
      if (!src.busy) this._close(fds, diskPath, src)
    }
  }

  /** @internal */
  countFor(peer) { return this._byPeer.get(peer)?.size ?? 0 }

  /** @internal */
  adoptForTests(peer, diskPath, src) {
    let fds = this._byPeer.get(peer)
    if (!fds) { fds = new Map(); this._byPeer.set(peer, fds) }
    fds.set(diskPath, src)
  }

  // Removing the entry first is what stops a later read from finding a closed descriptor; the
  // close itself waits for any read still in flight.
  _close(fds, diskPath, src) {
    fds.delete(diskPath)
    if (src.busy) { src.pendingClose = true; return }
    this._drop(src.fd)
  }

  // Best-effort; Promise.resolve() tolerates a reads object whose close returns nothing.
  _drop(fd) {
    Promise.resolve(this._reads.closeChunkSource(fd)).catch(() => {})
  }
}
