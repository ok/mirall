// A fetch's no-progress watchdog and its evidence. The timer is re-armed on every forward-progress
// signal, so only a genuine stall fails the fetch, whatever the file size. It runs only while
// something is outstanding with a peer (chunks in flight, or a request whose list has not come
// back): waiting on our own download cap is not silence, since nobody is there to be silent. It
// asks the scheduler only through `view` and never touches chunks.

// Reset on every accepted chunk and on the first chunk list, so a steadily progressing transfer
// never trips it.
const DEFAULT_IDLE_TIMEOUT = 30000
// The longest a holder's keep-alives, or its transport bytes, may hold a fetch open with no chunk
// accepted. It bounds a peer that keeps signalling while sending nothing, so every legitimate wait
// must fit inside it: chunk size × files that holder serves us × peers it serves ÷ its upload cap.
// A 4 MB tier-3 chunk at the 32 KB/s cap floor costs 128 s alone and 21 minutes once the holder
// serves ten transfers; 30 minutes covers that product up to ~14 at the floor.
const KEEPALIVE_MAX_SILENCE_MS = 1800000
// The smallest inbound byte delta from one peer, per idle window, that counts as delivery. An idle
// connection is not silent (a keep-alive every 5 s plus UDX ACKs, about 360 B per 30 s window), so
// the floor is what keeps a wedged but connected peer catchable. 64 KiB is ~180x that floor and
// ~3x under the slowest delivery it protects, a 4 MiB chunk on a 56 kbit/s link.
const MIN_LIVENESS_BYTES = 64 * 1024
// How much a peer may deliver without delivering a chunk it owes before we stop believing the
// chunks are coming. Bytes prove the peer is alive, not that our batch is being served: every early
// return in the holder's serve loop leaves it as busy as one mid-chunk. The budget is what it owes
// plus one protomux send batch of unrelated traffic, so a chunk queued behind a replication burst
// gets through and a dropped batch is caught in proportion to that peer's own traffic.
const ABANDON_FACTOR = 2
const ABANDON_SLACK_BYTES = 8 * 1024 * 1024

// An option that is not a usable number falls back to the default: 0, a negative or a NaN would
// each fail open through the gates below.
const positive = (value, fallback) => (Number.isFinite(value) && value > 0 ? value : fallback)

export class Liveness {
  // `view` answers: suppressed() (done, finalizing or setting up), idleByDesign() (nothing
  // outstanding and the cap has our retry registered), done(), inflightPeers() (peer → count) and
  // owedBytes(peer). `peerBytes(peer)` reads a peer's transport RX counter; absent, every gate that
  // needs it is skipped. `onStall(err)` fails the fetch.
  constructor({ idleTimeout, keepAliveMaxSilence, peerBytes, minLivenessBytes, abandonSlackBytes, view, onStall }) {
    this.idleTimeout = idleTimeout || DEFAULT_IDLE_TIMEOUT
    this._keepAliveMaxSilence = keepAliveMaxSilence || KEEPALIVE_MAX_SILENCE_MS
    this._peerBytes = peerBytes || null
    this._minLivenessBytes = positive(minLivenessBytes, MIN_LIVENESS_BYTES)
    this._abandonSlack = positive(abandonSlackBytes, ABANDON_SLACK_BYTES)
    this._view = view
    this._onStall = onStall
    this._timer = null
    // When the fetch last made VERIFIED progress: a hash-checked chunk accepted, or local setup
    // completing. Only this bounds a keep-alive's reach, so nothing a remote peer can drive at
    // will — a chunk list, a page, an assign — may move it.
    this._lastProgressAt = Date.now()
    this._rxProbe = new Map()  // peer → { bytes, at } the delivery floor is measured from
    this._rxAtOwe = new Map()  // peer → transport bytes when its current debt began
  }

  // A re-arm while suppressed would resurrect a timer that finalize or setup disabled on purpose,
  // and stall-fail a healthy transfer: assign re-arms unconditionally, and a second holder's list
  // re-enters it mid-setup.
  arm() {
    if (this._view.suppressed()) return
    clearTimeout(this._timer)
    this._timer = null
    if (this._view.idleByDesign()) return
    this._timer = setTimeout(() => this._onExpiry(), this.idleTimeout)
  }

  clear() { clearTimeout(this._timer) }

  noteProgress() { this._lastProgressAt = Date.now() }

  // Whether an unverifiable liveness claim may still extend the fetch.
  withinReach() { return Date.now() - this._lastProgressAt <= this._keepAliveMaxSilence }

  // (Re)take this peer's baselines: the per-window probe the delivery floor is measured from, and,
  // with `debt`, the anchor the abandon budget counts from. A read that cannot be taken clears
  // both, since a stale baseline would measure the wrong span.
  anchor(peer, debt = false) {
    if (!this._peerBytes) return
    const n = this.rx(peer)
    if (n === null) {
      this._rxProbe.delete(peer)
      if (debt) this._rxAtOwe.delete(peer)
      return
    }
    this._rxProbe.set(peer, { bytes: n, at: Date.now() })
    if (debt) this._rxAtOwe.set(peer, n)
  }

  // A peer's debt, and the window its delivery is measured over, starts when we ask it.
  anchorIfUnset(peer) {
    if (!this._rxAtOwe.has(peer)) this.anchor(peer, true)
  }

  // A peer that just paid starts a fresh debt. While it still owes chunks the anchor MOVES rather
  // than clears: at the end of a file every remaining chunk is already in flight, so no later
  // assign would re-seed it.
  restartDebt(peer, stillOwes) {
    if (!this._peerBytes) return
    if (stillOwes) return this.anchor(peer, true)
    this._rxAtOwe.delete(peer)
    this._rxProbe.delete(peer)
  }

  // The maps are keyed by the peer object, so a leftover entry pins its whole mux graph.
  forget(peer) {
    this._rxProbe.delete(peer)
    this._rxAtOwe.delete(peer)
  }

  // One transport read, defended: the counter is a getter over native memory that can throw on a
  // destroyed stream, and only a finite count is an answer (Infinity would read as "alive").
  /** @internal */
  rx(peer) {
    if (!this._peerBytes) return null
    let n
    try { n = this._peerBytes(peer) } catch { return null }
    return Number.isFinite(n) && n >= 0 ? n : null
  }

  // The watchdog is asked "is this peer dead?" but a completed chunk is weak evidence whenever one
  // chunk outlives the window (a 4 MiB chunk needs 33.6 s at 1 Mbit/s). The transport is asked
  // before failing; a peer that has gone away delivers nothing, so a wedged one is still caught.
  _onExpiry() {
    if (this._view.done()) return
    if (this._transportAlive()) return this.arm()
    this._onStall(new Error('multi-source fetch stalled (no progress for ' + this.idleTimeout + 'ms)'))
  }

  // Only a peer holding chunks of ours may extend the watchdog. A peer we merely asked may never
  // answer (it lacks the file, or its serve gate denied us), and letting its unrelated traffic
  // re-arm us would hand any connected peer an unbounded hold.
  _transportAlive() {
    if (!this._peerBytes || !this.withinReach()) return false
    let alive = false
    for (const [peer, n] of this._view.inflightPeers()) {
      if (n <= 0) continue
      if (this._delivering(peer)) alive = true
      this.anchor(peer)
    }
    return alive
  }

  _delivering(peer) {
    const probe = this._rxProbe.get(peer)
    const atOwe = this._rxAtOwe.get(peer)
    if (probe === undefined || atOwe === undefined) return false
    const now = this.rx(peer)
    if (now === null || now < probe.bytes) return false
    // A rate, not a count: a window that ran long needs proportionally more bytes.
    const elapsed = Math.max(1, Date.now() - probe.at)
    if ((now - probe.bytes) * this.idleTimeout < this._minLivenessBytes * elapsed) return false
    return now - atOwe <= this._view.owedBytes(peer) * ABANDON_FACTOR + this._abandonSlack
  }
}
