// How many bytes a peer's transport has moved, and a wait for a backpressured stream to drain.

// A serve loop whose stream neither drains nor closes within this window is abandoned, and the
// receiver re-requests. Used only when the transport cannot report send progress, since then slow
// and wedged look the same and the window has to cover a whole flush: one 4 MiB tier-3 chunk is
// 33.6 s at 1 Mbit/s.
const DRAIN_TIMEOUT_MS = 60000
// With a TX counter the wait abandons a peer only after this long with no bytes leaving for it,
// and re-arms while bytes still leave: it measures liveness, not a flush budget.
const DRAIN_NO_PROGRESS_MS = 20000

// Cumulative bytes received from this peer's transport, for the downloader's watchdog. udx's
// `bytesReceived` counts packets, so it advances while one large frame is still arriving;
// `rawBytesRead` counts decrypted frames and is blind for exactly that wait, so it is the last
// resort. Null when nothing is measurable.
export function peerRxBytes(peer) {
  const stream = peer?.mux?.stream
  if (!stream) return null
  const raw = stream.rawStream
  if (raw) {
    const packets = raw.bytesReceived
    if (Number.isFinite(packets)) return packets
    const socket = raw.bytesRead
    if (Number.isFinite(socket)) return socket
  }
  const frames = stream.rawBytesRead
  return Number.isFinite(frames) ? frames : null
}

// Bytes this peer's transport has put on the wire, packets first for the same reason as
// peerRxBytes. Null when nothing is measurable, and the drain wait then falls back to a flat budget.
export function peerTxBytes(peer) {
  const raw = peer?.mux?.stream?.rawStream
  if (!raw) return null
  if (Number.isFinite(raw.bytesTransmitted)) return raw.bytesTransmitted
  return Number.isFinite(raw.bytesWritten) ? raw.bytesWritten : null
}

// One shared waiter per peer, so concurrent serve loops to the same peer attach one pair of
// listeners rather than tripping the stream's max-listeners warning. wait() resolves true on
// drain, false when the channel closes or the peer stops taking bytes.
export function createDrainWaiter({ drainTimeout = null, drainNoProgress = null } = {}) {
  const flatBudget = drainTimeout ?? DRAIN_TIMEOUT_MS
  const idleBudget = drainNoProgress ?? DRAIN_NO_PROGRESS_MS
  const waits = new WeakMap()

  function wait(peer) {
    const channel = peer.channel
    const stream = peer.mux && peer.mux.stream
    if (!stream || !channel || channel.closed) return Promise.resolve(false)
    if (channel.drained) return Promise.resolve(true)
    const pending = waits.get(peer)
    if (pending) return pending
    const waiting = new Promise((resolve) => {
      let timer = null
      const done = (alive) => {
        if (timer) clearTimeout(timer)
        stream.removeListener('drain', onDrain)
        stream.removeListener('close', onClose)
        waits.delete(peer)
        resolve(alive)
      }
      const onDrain = () => done(!channel.closed)
      const onClose = () => done(false)
      let tx = peerTxBytes(peer)
      const tick = () => {
        const now = tx === null ? null : peerTxBytes(peer)
        if (now === null || now <= tx) return done(false)
        tx = now
        // Not unref'd: this timer is what resolves the wait.
        timer = setTimeout(tick, idleBudget)
      }
      timer = setTimeout(tick, tx === null ? flatBudget : idleBudget)
      stream.on('drain', onDrain)
      stream.on('close', onClose)
    })
    waits.set(peer, waiting)
    return waiting
  }

  return { wait }
}
