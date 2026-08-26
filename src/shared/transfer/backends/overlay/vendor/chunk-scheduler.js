/**
 * ChunkScheduler — multi-source (torrent-style) fetch of one content-addressed
 * file across several peers, modelled on Hypercore's block replicator.
 *
 * Chunks are content-addressed, so any peer holding the file can serve any
 * chunk. The scheduler:
 *  - requests the chunk list from each peer (identical, content-addressed),
 *  - tracks a global `inflight` map so each chunk is requested from exactly
 *  ONE peer at a time (no wasted bandwidth),
 *  - keeps each peer busy up to a per-peer inflight cap (parallel download),
 *  - reassigns a peer's inflight chunks to others on stall/disconnect,
 *  - hash-verifies every chunk (via TransferManager.writeChunk) and the whole
 *  file before finalizing.
 *
 * It drives the EXISTING v2 wire messages (chunk-need / chunk-data) — no new
 * message type is needed for the full-copy-seeder case. The protocol delegates
 * `_onChunkHashes` / `_onChunkData` to a scheduler ONLY when one is registered
 * for the synthetic `content:<hash>` path, so the legacy single-peer flow
 * (pgh NetworkFetcher) is untouched.
 */

import { hashChunk } from './chunker.js'

const DEFAULT_CAP = 8
// [mirall] How far _assign scans past chunks the download cap cannot currently afford
// before giving up on this round. See the gated branch in _assign.
const GATED_SCAN_LIMIT = 32
// [mirall] §HOL — cede the worker loop every YIELD_EVERY accepted chunks so a burst of
// buffered chunkData frames (protomux dispatches every frame from one socket read
// synchronously) can't starve the profile-bee `append` listener that surfaces a
// freshly shared folder to a peer mid-download. Kept local (not imported from
// transfer.js) so this module stays node-loadable for the brittle-node unit suite.
const yieldToLoop = () => new Promise((resolve) => setTimeout(resolve, 0))
const YIELD_EVERY = 16
// [mirall] Idle (no-progress) timeout, reset on every accepted chunk and on the
// initial chunk-list response. A steadily-progressing transfer never trips it —
// only a genuine stall (no bytes for this long) fails. A fixed OVERALL timeout
// here capped large transfers (e.g. a multi-GB file at any bandwidth always
// exceeded 30s) and aborted them mid-stream.
const DEFAULT_IDLE_TIMEOUT = 30000
// [mirall] FIX-BW9 — longest a holder's keep-alives (message 14, "I am parked on my own
// upload cap") may hold this fetch open with no bytes accepted. It exists to bound a peer that
// keep-alives forever while sending nothing; every legitimate wait must fit INSIDE it or the
// fix silently stops working at exactly the loads it was written for.
//
// Size it from the same formula the bug does — chunkBytes x filesFromThatPeer x
// peersBeingServed / cap — not from one chunk in isolation: a 4 MB tier-3 chunk at the 32 KB/s
// cap floor costs 128 s alone, but 21 minutes once that holder is serving ten transfers. A
// 5-minute bound (the first cut here) covered only F x P < 3 and would have re-broken the
// transfer it just fixed. 30 minutes covers F x P up to ~14 at the floor, and a peer that
// stalls a single fetch for 30 minutes costs one download slot — strictly less than the
// unbounded hold a trickle of one chunk per 29 s already buys it.
const KEEPALIVE_MAX_SILENCE_MS = 1800000
// [mirall] FIX-BW10 — smallest inbound byte delta from ONE peer, within one idle window, that
// counts as delivery. Sized against the noise floor, not against a transfer: an idle connection
// is not silent (an empty keep-alive every 5 s plus UDX ACKs — measured at 360 B per 30 s
// window), so a floor is what keeps a wedged-but-connected peer catchable. 64 KiB is ~180x that
// floor and still ~3x under the slowest delivery this protects, a 4 MiB tier-3 chunk on a
// 56 kbit/s link (~210 KB per window).
const MIN_LIVENESS_BYTES = 64 * 1024
// [mirall] FIX-BW10 — how much a peer may deliver WITHOUT delivering any chunk it owes us before
// we stop believing the chunks are coming. Bytes prove the peer is alive, not that our batch is
// still being served: every early return in the holder's serve loop (file unreadable, grant
// revoked, drain abandoned) leaves it as busy as one mid-chunk. Budgeting against what it owes
// plus one protomux send-batch of unrelated traffic lets a chunk queued behind a replication
// burst through, and catches a dropped batch in proportion to that peer's own traffic instead of
// at KEEPALIVE_MAX_SILENCE_MS.
const ABANDON_FACTOR = 2
const ABANDON_SLACK_BYTES = 8 * 1024 * 1024
// [mirall] FIX-BW10 — `??` alone would accept 0, a negative or a NaN, and every one of those
// fails OPEN through the gates below (a floor of NaN is never exceeded, a negative budget is
// always exceeded), so an option that is not a usable number falls back to the default.
const positive = (value, fallback) => (Number.isFinite(value) && value > 0 ? value : fallback)
// [mirall] Local write-error codes that may recover on retry (vs ENOSPC/EACCES/…
// which are fatal): a transient one keeps the chunk retryable instead of failing
// the whole multi-source fetch.
const TRANSIENT_WRITE_CODES = new Set(['EBUSY', 'EAGAIN', 'EINTR', 'EMFILE', 'ENFILE'])
// [mirall] Min interval between have-progress reports to holders (their sender-side bar).
// Throttles the transferProgress frames so a fast transfer can't spam holders.
const DEFAULT_REPORT_INTERVAL = 1000

export class ChunkScheduler {
  /**
   * @param {object} opts
   *  opts.path synthetic path key ('content:<hash>')
   *  opts.destPath where the assembled file is written
   *  opts.transfer TransferManager
   *  opts.sendNeed (peer, indices[]) => void — sends a chunk-need message
   *  opts.cap per-peer inflight cap (default 8)
   *  opts.timeout idle (no-progress) timeout ms (default 30000)
   *  opts.onProgress optional (receivedBytes, totalBytes) => void on each accepted chunk
   */
  constructor (opts) {
    this.path = opts.path
    this.destPath = opts.destPath
    this._transfer = opts.transfer
    this._sendNeed = opts.sendNeed
    this._cap = opts.cap || DEFAULT_CAP
    this._onProgress = opts.onProgress || null
    this._onVerify = opts.onVerify || null
    this._onBaseline = opts.onBaseline || null
    this._reportInterval = opts.reportInterval ?? DEFAULT_REPORT_INTERVAL
    this._lastReportAt = 0
    // [mirall] cumulative byte accounting so onProgress can drive a
    // remaining-bytes/ETA bar, not just a chunk count.
    this._receivedBytes = 0
    this._totalBytes = 0
    this._sinceYield = 0   // [mirall] §HOL event-loop yield counter

    this._peers = new Set()
    // [mirall] Peers we have sent a content-request to but not yet heard a chunk list from. A peer
    // only enters _peers once its list arrives, so without this a holder that dies inside that
    // window is invisible to removePeer and the fetch waits out the whole idle timeout instead of
    // failing fast — 30s in which the transfer still holds its slot and every reconnect-driven
    // resume is skipped as "already downloading".
    this._requested = new Set()
    this._started = false
    this._settingUp = false
    this._finalizing = false
    this._done = false
    this._chunks = null            // [{ hash, offset, length }]
    this._needed = new Set()       // indices not yet written
    this._inflight = new Map()     // index → peer (one peer per chunk)
    this._peerInflight = new Map() // peer → count
    this._peerCursor = 0           // [mirall] rotates which holder _assign offers to first
    // [mirall] True only while the download cap is holding us back AND the limiter has our
    // retry registered. Gates the idle watchdog — see _armIdleTimer.
    this._pacing = false
    this._received = new Map()     // peer → chunks accepted (multi-source proof)

    this._resolve = null
    this._reject = null
    this._onEnd = opts.onEnd || null
    this._contentHash = opts.contentHash || null   // [mirall] enables incremental whole-file verify
    this._limiter = opts.limiter || null           // [mirall] download cap; absent → unthrottled
    this._startedAt = Date.now()
    // [mirall] idle timeout — re-armed on each progress signal (see _armIdleTimer).
    this._idleTimeout = opts.timeout || DEFAULT_IDLE_TIMEOUT
    this._timer = null
    // [mirall] FIX-BW9 — when this fetch last made VERIFIED forward progress: a hash-checked
    // chunk accepted, or local setup completing. Only this bounds a keep-alive's reach, so
    // nothing a remote peer can drive at will may feed it — a chunk list and a chunkHashes
    // page both arrive from any connected peer for the asking, and refreshing the bound with
    // one would hand a liar exactly the unbounded hold the bound exists to deny (FIX-BW4).
    // _assign is excluded for the same reason: re-arming the watchdog is not progress.
    this._lastProgressAt = Date.now()
    this._keepAliveMaxSilence = opts.keepAliveMaxSilence || KEEPALIVE_MAX_SILENCE_MS
    // [mirall] FIX-BW10 — (peer) => cumulative bytes received from that peer's TRANSPORT, injected
    // by the protocol. Absent, every gate that reads it is skipped and the watchdog behaves as it
    // did without this.
    this._peerBytes = opts.peerBytes || null
    this._minLivenessBytes = positive(opts.minLivenessBytes, MIN_LIVENESS_BYTES)
    this._abandonSlack = positive(opts.abandonSlackBytes, ABANDON_SLACK_BYTES)
    this._rxProbe = new Map()      // peer → { bytes, at } the delivery floor is measured from
    this._rxAtOwe = new Map()      // peer → transport bytes when its current debt began
    this._armIdleTimer()
  }

  promise () {
    return new Promise((resolve, reject) => { this._resolve = resolve; this._reject = reject })
  }

  // [mirall] (Re)arm the no-progress watchdog. Called at construction and on every
  // forward-progress signal so only a genuine stall — no accepted bytes for the
  // idle window — aborts the fetch, regardless of total file size.
  _armIdleTimer () {
    // [mirall] `_finalizing` and `_settingUp` as well as `_done`. _finalize clears this timer
    // because the digest drain outlasts the window, and onChunkHashes clears it for the
    // journal-less resume re-verify; `_done` is false throughout both awaits, so any re-arm
    // inside them resurrects a timer that was deliberately disabled and stall-fails a
    // healthy transfer. _assign re-arms unconditionally and a second holder's chunk list
    // re-enters it mid-setup, so this guard is load-bearing, not defensive.
    if (this._done || this._finalizing || this._settingUp) return
    clearTimeout(this._timer)
    this._timer = null
    // [mirall] The watchdog measures SILENCE FROM A PEER, so it only runs while something is
    // actually outstanding with one: chunks in flight, or a content request whose chunk list
    // has not come back. Waiting on our own bandwidth cap is not silence — there is nobody to
    // be silent — so a paced transfer is not timed.
    //
    // Suppressing it that way, rather than re-arming it on a timer while gated, is what keeps
    // a low cap from failing a healthy transfer WITHOUT blinding the watchdog: a heartbeat
    // that re-arms on pacing alone never fires again, so a peer that wedges while still
    // TCP-alive (no FIN, so removePeer never runs) is never detected at all.
    //
    // `_pacing` — not merely "nothing outstanding" — is the condition, because the limiter can
    // REFUSE to register our retry (torn down, handle detached). That is not pacing, it is a
    // dead end with no callback coming, and the watchdog is then the only thing that can end
    // the fetch instead of leaking the download slot forever.
    if (this._inflight.size === 0 && this._requested.size === 0 && this._pacing) return
    this._timer = setTimeout(() => this._onIdleExpiry(), this._idleTimeout)
  }

  // [mirall] FIX-BW10 — the watchdog is asked "is this peer dead?" but its only evidence was "has
  // a chunk completed?", and those diverge whenever ONE chunk outlives the window: a 4 MiB tier-3
  // chunk needs 33.6 s at 1 Mbit/s, and one queued behind other traffic on the same Noise stream
  // takes longer still. Ask the transport before failing — a peer that has gone away delivers
  // nothing, so a wedged-but-TCP-alive peer is still caught by construction.
  _onIdleExpiry () {
    if (this._done) return
    if (this._transportAlive()) return this._armIdleTimer()
    this._fail(new Error('multi-source fetch stalled (no progress for ' + this._idleTimeout + 'ms)'))
  }

  // [mirall] FIX-BW10 — only a peer holding chunks of OURS may extend the watchdog. A peer we
  // merely sent a content request to is deliberately excluded: it may never answer at all (a
  // holder that lacks the file, or one whose serve gate denied us, both return silently), so
  // letting its unrelated traffic on the shared mux re-arm us would hand any connected peer an
  // unbounded hold — FIX-BW4 through the gate meant to preserve it. Fast-failing that wait is
  // exactly what `_requested` exists for.
  _transportAlive () {
    if (!this._peerBytes) return false
    // Same bound a keep-alive gets, for the same reason: an extension that renews itself forever
    // is a watchdog that never fires. _lastProgressAt moves only on VERIFIED progress.
    if (Date.now() - this._lastProgressAt > this._keepAliveMaxSilence) return false
    let alive = false
    for (const [peer, n] of this._peerInflight) {
      if (n <= 0) continue
      if (this._delivering(peer)) alive = true
      this._anchor(peer)   // re-baseline for the next window, granted or not
    }
    return alive
  }

  // [mirall] FIX-BW10 — is this peer putting bytes on the wire for us? Two questions, both
  // answerable only from a baseline we took ourselves, so an unmeasured peer never extends
  // anything.
  _delivering (peer) {
    const probe = this._rxProbe.get(peer)
    const atOwe = this._rxAtOwe.get(peer)
    if (probe === undefined || atOwe === undefined) return false
    const now = this._rx(peer)
    if (now === null || now < probe.bytes) return false
    // A RATE, not a count: the floor is _minLivenessBytes per idle window, so a window that ran
    // long (chunks kept arriving, the timer kept being re-armed) needs proportionally more.
    // Below it is protocol chatter — an idle Noise stream still carries a keep-alive every 5 s.
    const elapsed = Math.max(1, Date.now() - probe.at)
    if ((now - probe.bytes) * this._idleTimeout < this._minLivenessBytes * elapsed) return false
    // Alive — but are the bytes ours? See ABANDON_FACTOR.
    return now - atOwe <= this._owedBytes(peer) * ABANDON_FACTOR + this._abandonSlack
  }

  // [mirall] Bytes this peer could legitimately be sending us right now.
  _owedBytes (peer) {
    let total = 0
    for (const [index, p] of this._inflight) {
      if (p !== peer) continue
      const len = this._chunks?.[index]?.length
      if (len > 0) total += len
    }
    return total
  }

  // [mirall] One transport read, defended: the counter is a getter over native memory and can
  // throw on a destroyed stream, and an embedder may return anything. Infinity would poison every
  // comparison below into a NaN that reads as "alive", so only a finite count is an answer.
  _rx (peer) {
    if (!this._peerBytes) return null
    let n
    try { n = this._peerBytes(peer) } catch { return null }
    return Number.isFinite(n) && n >= 0 ? n : null
  }

  // [mirall] FIX-BW10 — (re)take this peer's baselines. The probe is the per-window one the
  // delivery floor is measured from; the debt anchor is where the abandon budget counts from and
  // moves only when the debt itself restarts (a fresh batch, or a chunk just paid). A read we
  // cannot take clears both, since a stale baseline would measure the wrong span.
  _anchor (peer, debt = false) {
    if (!this._peerBytes) return
    const n = this._rx(peer)
    if (n === null) {
      this._rxProbe.delete(peer)
      if (debt) this._rxAtOwe.delete(peer)
      return
    }
    this._rxProbe.set(peer, { bytes: n, at: Date.now() })
    if (debt) this._rxAtOwe.set(peer, n)
  }

  // [mirall] FIX-BW10 — a peer that just paid starts a fresh debt. While it still owes chunks the
  // anchor must MOVE rather than clear: at the end of a file every remaining chunk is already in
  // flight, so no later assign hands out a batch that would re-seed it, and an unanchored peer is
  // one that cannot be budgeted.
  _restartDebt (peer) {
    if (!this._peerBytes) return
    if ((this._peerInflight.get(peer) || 0) > 0) return this._anchor(peer, true)
    this._rxAtOwe.delete(peer)
    this._rxProbe.delete(peer)
  }

  _reportEnd (ok, reason) {
    if (!this._onEnd) return
    try {
      this._onEnd({
        ok,
        reason,
        receivedBytes: this._receivedBytes,
        totalBytes: this._totalBytes,
        chunksRemaining: this._needed.size,
        totalChunks: this._chunks ? this._chunks.length : 0,
        peers: this._peers.size,
        elapsedMs: Date.now() - this._startedAt,
      })
    } catch {}
  }

  _fail (err) {
    if (this._done) return
    this._done = true
    clearTimeout(this._timer)
    this._detachLimiter()
    this._reportEnd(false, err.message)
    // [mirall] Release the receiver state at the failure boundary: journal the hash
    // frontier and close the fd + chunk stash so a never-retried failure parks
    // nothing (the partial stays on disk for a later resume). Best-effort — the
    // external-stop path (cancel) does its own pause/cancel before rejecting.
    if (this._transfer && typeof this._transfer.pause === 'function') {
      try { Promise.resolve(this._transfer.pause(this.destPath)).catch(() => {}) } catch {}
    }
    if (this._reject) this._reject(err)
  }

  _finish () {
    if (this._done) return
    this._done = true
    clearTimeout(this._timer)
    this._detachLimiter()
    this._reportEnd(true, 'complete')
    if (this._resolve) this._resolve({ chunksPerPeer: this._received, peerCount: this._received.size, size: this._totalBytes })
  }

  // [mirall] External stop (pause or discard). The partial is kept or unlinked by
  // the caller (OverlayProtocolV2.cancelContent via TransferManager.pause/cancel)
  // BEFORE this; here we only stop the loop and reject the fetch with ECANCELLED.
  cancel () {
    if (this._done) return
    this._done = true
    clearTimeout(this._timer)
    this._detachLimiter()
    this._reportEnd(false, 'cancelled')
    const err = new Error('fetch cancelled')
    err.code = 'ECANCELLED'
    if (this._reject) this._reject(err)
  }

  get done () { return this._done }

  // [mirall] §4.12 — a chunkHashes page arrived while a large map is still
  // streaming across multiple frames. Receiving it is forward progress, so
  // re-arm the no-progress watchdog (the full list dispatches via onChunkHashes
  // only once the final page lands).
  notePageProgress () { if (!this._done && !this._settingUp) this._armIdleTimer() }

  // [mirall] FIX-BW9 — a holder tells us it is parked on its OWN upload cap (protocol-v2 sends
  // message 14 while a serve loop waits on take()). Being paced by someone else's cap is not
  // silence — but we cannot verify the claim, so two gates keep this from re-creating FIX-BW4,
  // a watchdog that never fires:
  //   - the frame must name a chunk THIS peer currently owes us, so a peer with nothing
  //     outstanding — or one serving us nothing at all — cannot hold a fetch open on zero bytes;
  //   - the reach is bounded by the last real progress, so a peer that keep-alives forever while
  //     sending nothing is still failed, just later than a silent one.
  // Deliberately does NOT touch _lastProgressAt: a keep-alive is a claim about the future, not
  // progress, and letting it refresh its own bound would make the bound unreachable.
  notePeerAlive (peer, index) {
    if (this._done) return
    if (this._inflight.get(index) !== peer) return
    if (Date.now() - this._lastProgressAt > this._keepAliveMaxSilence) return
    this._armIdleTimer()
  }

  /** A peer responded with the chunk list. First response starts the transfer. */
  async onChunkHashes (peer, chunks) {
    this._requested.delete(peer) // it answered — from here on its loss is handled by _peers
    if (this._done) return
    this._peers.add(peer)
    if (!this._peerInflight.has(peer)) this._peerInflight.set(peer, 0)

    if (!this._started) {
      this._started = true
      // The async startReceive (journal-less resume re-verify) can run for a while
      // and accepts no chunks; suppress the no-progress watchdog (including later
      // peers' re-arms) until setup completes, or a concurrent seeder's chunk list
      // would re-arm it and self-trip a healthy resume.
      this._settingUp = true
      clearTimeout(this._timer)
      // Derive offsets from the ordered chunk lengths.
      let offset = 0
      this._chunks = chunks.map((c) => {
        const entry = { hash: c.hash, offset, length: c.length }
        offset += c.length
        return entry
      })
      this._totalBytes = offset   // [mirall] file size = sum of chunk lengths
      let state
      try {
        state = await this._transfer.startReceive(
          this.destPath,
          { size: offset, chunks: this._chunks, contentHash: this._contentHash },
          { isCancelled: () => this._done, onVerifyProgress: this._onVerify }
        )
      } catch (err) {
        this._settingUp = false
        if (this._done) return
        return this._fail(err)
      }
      this._settingUp = false
      if (this._done) return
      // [mirall] FIX-BW9 — the keep-alive budget starts HERE, not at construction: the
      // startReceive above (a journal-less partial re-verify) can run for minutes on a large
      // file, and charging that to the budget spends it before the first keep-alive lands.
      this._lastProgressAt = Date.now()
      // [mirall] resume: only fetch chunks the partial doesn't already hold, and
      // seed the byte counter so progress/ETA continue from the resumed offset.
      let have = 0
      for (let i = 0; i < this._chunks.length; i++) {
        if (state.received.has(i)) have += this._chunks[i].length
        else this._needed.add(i)
      }
      this._receivedBytes = have
      if (have > 0) {
        // [mirall] report our resume have-bytes so holders' sender-side bars mirror our
        // true progress, not just the bytes they re-serve. Re-sent periodically as more
        // chunks land (onChunkData) so late-joining and multi-source holders stay in sync.
        this._reportHave(Date.now())
        if (this._onProgress) { try { this._onProgress(this._receivedBytes, this._totalBytes) } catch {} }
      }
      this._armIdleTimer()
      if (this._needed.size === 0) return this._finalize()
      return this._assign()
    }
    if (!this._settingUp) this._armIdleTimer()   // [mirall] a later peer's list is forward progress
    this._assign()
  }

  /** A chunk arrived from a peer. Verify + write, then schedule more. */
  async onChunkData (peer, index, data) {
    if (this._done) return
    const res = this._transfer.writeChunk(this.destPath, index, data)
    // Free the inflight slot regardless — a bad chunk should be re-fetched.
    if (this._inflight.get(index) === peer) {
      this._inflight.delete(index)
      this._peerInflight.set(peer, Math.max(0, (this._peerInflight.get(peer) || 1) - 1))
    }
    if (!res.ok) {
      // [mirall] Same refund as removePeer: a retried chunk is re-charged on re-assign.
      this._refund(index)
      // [mirall] A coded failure is a local fs error. A TRANSIENT code (device busy,
      // fd pressure, interrupted syscall) can succeed on retry — leave the chunk in
      // `needed` and reassign. Any other coded error (ENOSPC / EACCES / ENOENT / …) is
      // fatal: fail the whole fetch carrying the code. No code = a hash/length
      // mismatch — also retried elsewhere.
      if (res.code && !TRANSIENT_WRITE_CODES.has(res.code)) {
        const err = new Error('write failed: ' + res.error)
        err.code = res.code
        return this._fail(err)
      }
      this._assign()
      return
    }
    this._needed.delete(index)
    this._lastProgressAt = Date.now()   // [mirall] FIX-BW9 — bounds how far a keep-alive can reach
    this._restartDebt(peer)             // [mirall] FIX-BW10 — it paid; measure the next debt from here
    this._received.set(peer, (this._received.get(peer) || 0) + 1)
    this._receivedBytes += (data ? data.length : 0)   // [mirall]
    this._armIdleTimer()   // [mirall] accepted bytes — reset the no-progress watchdog
    if (this._onProgress) { try { this._onProgress(this._receivedBytes, this._totalBytes) } catch {} }
    this._maybeReportHave()
    if (this._needed.size === 0 && this._inflight.size === 0) return this._finalize()
    // [mirall] §HOL — periodic event-loop yield (see YIELD_EVERY)
    if (++this._sinceYield >= YIELD_EVERY) {
      this._sinceYield = 0
      await yieldToLoop()
      if (this._done) return
    }
    this._assign()
  }

  // [mirall] Report our cumulative have-bytes to holders (their sender-side bar). Fired
  // once at resume, then throttled as chunks land, and once at finalize so the bar settles
  // at 100% across every holder regardless of who served what.
  _reportHave (now) {
    if (!this._onBaseline || this._receivedBytes <= 0) return
    this._lastReportAt = now
    try { this._onBaseline(this._receivedBytes) } catch {}
  }

  _maybeReportHave () {
    if (!this._onBaseline) return
    const now = Date.now()
    if (now - this._lastReportAt >= this._reportInterval) this._reportHave(now)
  }

  // [mirall] We asked this peer for the content; it has not answered yet. Tracked so its loss is
  // still a loss (see _requested).
  noteRequested (peer) {
    if (this._done) return
    this._requested.add(peer)
    // [mirall] Something is outstanding with a peer now, so the watchdog applies — see
    // _armIdleTimer, which no-ops while nothing is awaited.
    this._armIdleTimer()
  }

  /** A peer went away — return its inflight chunks to the pool. */
  // [mirall] Return a chunk's bytes to the download limiter. Safe to call for any index that
  // was charged by _assign; a no-op when unthrottled or when the chunk list is gone.
  // [mirall] Refund several abandoned chunks in one call. This is an efficiency, NOT a
  // correctness fix: `give` clamps the resulting total, and min(c, min(c, t+a)+b) equals
  // min(c, t+a+b), so N calls credit exactly what one summed call credits (measured).
  // The real limit is the clamp itself — a refund can never lift the bucket above one
  // second of budget, so churn beyond that genuinely loses the excess either way.
  _refundAll (indices) {
    if (!this._limiter || this._limiter.isUnlimited()) return
    let total = 0
    for (const index of indices) {
      const len = this._chunks?.[index]?.length
      if (len > 0) total += len
    }
    if (total > 0) this._limiter.give(total)
  }

  _refund (index) {
    this._refundAll([index])
  }

  // [mirall] This fetch is over (complete, failed or cancelled). Give up our place in the
  // limiter's queue and hand back any budget granted but never spent — otherwise a
  // transfer that ends between a grant and its assign leaks that credit out of the
  // shared bucket, and every remaining transfer runs below the configured cap.
  _detachLimiter () {
    if (typeof this._limiter?.detach !== 'function') return
    try { this._limiter.detach() } catch {}
  }

  removePeer (peer) {
    const wasRequested = this._requested.delete(peer)
    // [mirall] FIX-BW10 — above the early return: a peer that died before answering still has
    // baselines, and the Maps are keyed by the peer OBJECT, so leaving one behind pins its whole
    // mux/stream graph for the life of the fetch.
    this._rxProbe.delete(peer)
    this._rxAtOwe.delete(peer)
    if (!this._peers.has(peer)) {
      // [mirall] It died before its chunk list arrived. If it was the last holder we were waiting
      // on, the fetch is already doomed — fail now rather than idling for the full timeout.
      if (wasRequested && !this._done && this._peers.size === 0 && this._requested.size === 0) {
        return this._fail(new Error('all peers gone before any chunk list arrived'))
      }
      return
    }
    this._peers.delete(peer)
    this._peerInflight.delete(peer)
    const abandoned = []
    for (const [index, p] of this._inflight) {
      if (p !== peer) continue
      this._inflight.delete(index) // back to needed (still in _needed)
      abandoned.push(index)
    }
    // [mirall] The assign charged these bytes to the download limiter; the peer never
    // delivered them, and _assign() below re-charges the same chunk. Refund as ONE sum —
    // see _refundAll — or the bucket leaks on every peer churn and the achieved rate sinks
    // below the cap.
    this._refundAll(abandoned)
    if (this._done) return
    if (this._peers.size === 0 && this._requested.size === 0 && this._needed.size > 0) {
      return this._fail(new Error('all peers gone with ' + this._needed.size + ' chunk(s) outstanding'))
    }
    this._assign()
  }

  async _finalize () {
    if (this._finalizing || this._done) return
    this._finalizing = true
    this._reportHave(Date.now())   // [mirall] final have=total so holders' bars settle at 100%
    clearTimeout(this._timer)   // the digest drain can outlast the idle window
    let fin
    try { fin = await this._transfer.finalize(this.destPath) }
    catch (err) { return this._fail(err) }
    if (!fin.ok) {
      const err = new Error('finalize failed: ' + fin.error)
      if (fin.code) err.code = fin.code   // [mirall] preserve EHASHMISMATCH for the caller
      return this._fail(err)
    }
    this._finish()
  }

  /** Assign needed-but-not-inflight chunks to peers with spare capacity. */
  _assign () {
    if (this._done || !this._chunks) return
    // [mirall] A pull protocol paces its inbound bytes by pacing its REQUESTS, so the
    // download cap is charged here rather than on arrival (by then the bytes are spent).
    const limiter = this._limiter && !this._limiter.isUnlimited() ? this._limiter : null
    let gated = false
    let gatedBytes = 0
    let probes = 0
    let blocked = false
    // Per peer, batch the indices we hand it this round.
    const batches = new Map()
    // [mirall] Rotate which holder is offered chunks first. Under a cap a round's budget is
    // only a chunk or two, so a fixed starting peer takes all of it every time and the
    // others are never reached — multi-source fetch silently becomes single-source the
    // moment a user sets a limit. Iteration order of a Set is insertion order, hence the
    // explicit cursor.
    // Single holder is the common case and allocates nothing; the rotation array is built
    // only when there is something to rotate. _assign runs several hundred times a second
    // on the worker's single thread, so the difference is worth the branch.
    const peerCount = this._peers.size
    const peers = peerCount > 1 ? [...this._peers] : null
    if (peers) this._peerCursor = (this._peerCursor + 1) % peerCount
    const single = peers ? null : this._peers.values().next().value
    for (let n = 0; n < peerCount; n++) {
      const peer = peers ? peers[(this._peerCursor + n) % peerCount] : single
      if (blocked) break
      let slots = this._cap - (this._peerInflight.get(peer) || 0)
      if (slots <= 0) continue
      for (const index of this._needed) {
        if (slots <= 0) break
        if (this._inflight.has(index)) continue
        if (limiter) {
          // [mirall] Chunk sizes vary 4x within a tier, so an unaffordable chunk at the
          // head of `needed` must not block a smaller one behind it — scan on rather than
          // break. Two bounds, because `needed` can hold tens of thousands of entries:
          // `wouldBlock` stops immediately when the refusal is structural (nothing of any
          // size can be taken this round), and GATED_SCAN_LIMIT caps the size-only case.
          const len = this._chunks[index].length
          if (!limiter.tryTake(len)) {
            gatedBytes = gated ? Math.min(gatedBytes, len) : len
            gated = true
            // Optional: an embedder may inject a limiter without it, in which case only the
            // probe budget bounds the scan.
            if (typeof limiter.wouldBlock === 'function' && limiter.wouldBlock()) { blocked = true; break }
            if (++probes >= GATED_SCAN_LIMIT) break
            continue
          }
        }
        this._inflight.set(index, peer)
        this._peerInflight.set(peer, (this._peerInflight.get(peer) || 0) + 1)
        if (!batches.has(peer)) batches.set(peer, [])
        batches.get(peer).push(index)
        slots--
      }
      // [mirall] NOTE: no break on `gated` alone. Ending the peer loop the moment the cap
      // bites collapses multi-source fetch to single-source under ANY cap — the first peer
      // in iteration order gets gated before it ever fills its slots, so the others are
      // never reached. Only a structural block ends the round, since then no peer can be
      // served either.
    }
    for (const [peer, indices] of batches) {
      if (!indices.length) continue
      this._sendNeed(peer, indices)
      // [mirall] FIX-BW10 — a peer's debt (and the window its delivery is measured over) starts
      // at the moment we ask.
      if (!this._rxAtOwe.has(peer)) this._anchor(peer, true)
    }
    // [mirall] Register the retry BEFORE re-evaluating the watchdog: whether the limiter
    // accepted it is what separates "paced" (do not time it) from "stuck" (must time it).
    this._pacing = gated
      ? limiter.whenAvailable(gatedBytes, () => this._assign()) !== false
      : false
    this._armIdleTimer()
  }
}

export { hashChunk }
