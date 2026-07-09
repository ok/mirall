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
    this._started = false
    this._settingUp = false
    this._finalizing = false
    this._done = false
    this._chunks = null            // [{ hash, offset, length }]
    this._needed = new Set()       // indices not yet written
    this._inflight = new Map()     // index → peer (one peer per chunk)
    this._peerInflight = new Map() // peer → count
    this._received = new Map()     // peer → chunks accepted (multi-source proof)

    this._resolve = null
    this._reject = null
    this._onEnd = opts.onEnd || null
    this._contentHash = opts.contentHash || null   // [mirall] enables incremental whole-file verify
    this._startedAt = Date.now()
    // [mirall] idle timeout — re-armed on each progress signal (see _armIdleTimer).
    this._idleTimeout = opts.timeout || DEFAULT_IDLE_TIMEOUT
    this._timer = null
    this._armIdleTimer()
  }

  promise () {
    return new Promise((resolve, reject) => { this._resolve = resolve; this._reject = reject })
  }

  // [mirall] (Re)arm the no-progress watchdog. Called at construction and on every
  // forward-progress signal so only a genuine stall — no accepted bytes for the
  // idle window — aborts the fetch, regardless of total file size.
  _armIdleTimer () {
    if (this._done) return
    clearTimeout(this._timer)
    this._timer = setTimeout(
      () => this._fail(new Error('multi-source fetch stalled (no progress for ' + this._idleTimeout + 'ms)')),
      this._idleTimeout,
    )
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

  /** A peer responded with the chunk list. First response starts the transfer. */
  async onChunkHashes (peer, chunks) {
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

  /** A peer went away — return its inflight chunks to the pool. */
  removePeer (peer) {
    if (!this._peers.has(peer)) return
    this._peers.delete(peer)
    this._peerInflight.delete(peer)
    for (const [index, p] of this._inflight) {
      if (p === peer) this._inflight.delete(index) // back to needed (still in _needed)
    }
    if (this._done) return
    if (this._peers.size === 0 && this._needed.size > 0) {
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
    // Per peer, batch the indices we hand it this round.
    const batches = new Map()
    for (const peer of this._peers) {
      let slots = this._cap - (this._peerInflight.get(peer) || 0)
      if (slots <= 0) continue
      for (const index of this._needed) {
        if (slots <= 0) break
        if (this._inflight.has(index)) continue
        this._inflight.set(index, peer)
        this._peerInflight.set(peer, (this._peerInflight.get(peer) || 0) + 1)
        if (!batches.has(peer)) batches.set(peer, [])
        batches.get(peer).push(index)
        slots--
      }
    }
    for (const [peer, indices] of batches) {
      if (indices.length) this._sendNeed(peer, indices)
    }
  }
}

export { hashChunk }
