// SPDX-License-Identifier: AGPL-3.0-only
// Derived from hyper-overlay lib/chunk-scheduler.js @ 6cac8ee (v0.2.9), Copyright (C) 2026 the
// hyper-overlay authors, licensed AGPL-3.0. Modified for Mirall in 2026; PROVENANCE.md
// lists the changes and carries the full license notice.

// ChunkScheduler — multi-source fetch of one content-addressed file across several holders.
// Chunks are content-addressed, so any holder can serve any chunk. Each chunk is in flight to
// exactly one holder at a time, each holder is kept busy up to a per-holder cap, a holder's
// inflight chunks go back to the pool when it stalls or leaves, and every chunk and the whole
// file are hash-verified before the rename. Liveness, map admission and assignment are its
// siblings; this root owns one fetch's chunk state and lifecycle.

import { selectTier, getTierParams } from '../chunker.js'
import { isTransientWriteCode, codedError } from '../local-faults.js'
import { Liveness } from './liveness.js'
import { mapFault, maxMapEntries } from './map-admission.js'
import { planRound, refundChunks } from './assign.js'
import { yieldToLoop } from '../yield-to-loop.js'

const DEFAULT_CAP = 8
// Cede the worker loop every YIELD_EVERY accepted chunks: protomux dispatches every frame from one
// socket read synchronously, and a burst of chunkData would otherwise starve the profile-bee
// listener that surfaces a freshly shared folder to a peer mid-download.
const YIELD_EVERY = 16
// The least interval between have-progress reports to holders, so a fast transfer cannot spam them.
const DEFAULT_REPORT_INTERVAL = 1000

export class ChunkScheduler {
  // opts: path ('content:<hash>'), destPath, transfer (TransferManager), sendNeed(peer, indices),
  // cap (per-holder inflight), timeout (idle ms), onProgress(received, total), onVerify(fraction),
  // onBaseline(have), onEnd(report), contentHash (verified incrementally), size (the catalog size
  // the map must describe), parentMustExist (handed to startReceive), limiter (the download cap),
  // peerBytes(peer) (transport RX counter), keepAliveMaxSilence, minLivenessBytes,
  // abandonSlackBytes, reportInterval.
  constructor(opts) {
    this.path = opts.path
    this.destPath = opts.destPath
    this._transfer = opts.transfer
    this._sendNeed = opts.sendNeed
    this._cap = opts.cap || DEFAULT_CAP
    this._onProgress = opts.onProgress || null
    this._onVerify = opts.onVerify || null
    this._parentMustExist = !!opts.parentMustExist
    this._onBaseline = opts.onBaseline || null
    this._reportInterval = opts.reportInterval ?? DEFAULT_REPORT_INTERVAL
    this._lastReportAt = 0
    this._receivedBytes = 0
    this._totalBytes = 0
    this._sinceYield = 0

    this._peers = new Set()
    // Holders asked for the content that have not answered with a list yet. A holder enters _peers
    // only once its list arrives, so without this one that dies in between would be invisible to
    // removePeer and the fetch would wait out the whole idle timeout instead of failing fast.
    this._requested = new Set()
    this._started = false
    this._settingUp = false
    this._finalizing = false
    this._done = false
    this._chunks = null            // [{ hash, offset, length }]
    this._needed = new Set()       // indices not yet written
    this._inflight = new Map()     // index → peer (one peer per chunk)
    this._peerInflight = new Map() // peer → count
    this._peerCursor = 0
    // True only while the download cap holds us back AND the limiter has our retry registered.
    this._pacing = false
    this._received = new Map()     // peer → chunks accepted

    this._promise = null
    this._resolve = null
    this._reject = null
    this._onEnd = opts.onEnd || null
    this._contentHash = opts.contentHash || null
    // Null when the caller does not know the size.
    this._expectedSize = Number.isSafeInteger(opts.size) && opts.size > 0 ? opts.size : null
    this._tier = this._expectedSize === null ? null : getTierParams(selectTier(this._expectedSize))
    this._limiter = opts.limiter || null
    this._startedAt = Date.now()
    this.liveness = new Liveness({
      idleTimeout: opts.timeout,
      keepAliveMaxSilence: opts.keepAliveMaxSilence,
      peerBytes: opts.peerBytes,
      minLivenessBytes: opts.minLivenessBytes,
      abandonSlackBytes: opts.abandonSlackBytes,
      view: {
        suppressed: () => this._done || this._finalizing || this._settingUp,
        idleByDesign: () => this._inflight.size === 0 && this._requested.size === 0 && this._pacing,
        done: () => this._done,
        inflightPeers: () => this._peerInflight,
        owedBytes: (peer) => this._owedBytes(peer),
      },
      onStall: (err) => this._fail(err),
    })
    this.liveness.arm()
  }

  // One promise per fetch: every caller awaits the same settlement.
  promise() {
    if (!this._promise) this._promise = new Promise((resolve, reject) => { this._resolve = resolve; this._reject = reject })
    return this._promise
  }

  get done() { return this._done }

  cancel() {
    if (this._done) return
    this._end()
    this._reportEnd(false, 'cancelled')
    if (this._reject) this._reject(codedError('fetch cancelled', 'ECANCELLED'))
  }

  // A chunkHashes page arrived while a large map streams across frames: forward progress.
  notePageProgress() {
    if (!this._done && !this._settingUp) this.liveness.arm()
  }

  // A holder says it is parked on its own upload cap. The claim cannot be verified, so it counts
  // only for a chunk this peer owes us, and only within the reach of the last verified progress —
  // it never moves that bound itself.
  notePeerAlive(peer, index) {
    if (!this.awaitsChunk(peer, index)) return
    if (!this.liveness.withinReach()) return
    this.liveness.arm()
  }

  // Asked before a chunkHashes page is buffered: a peer we never asked can neither re-arm the
  // watchdog nor grow the page buffer.
  awaitsMapFrom(peer) { return !this._done && this._requested.has(peer) }

  // A chunk is taken only from the peer the assignment asked (and charged) for it.
  awaitsChunk(peer, index) { return !this._done && this._inflight.get(index) === peer }

  // The most entries a map of this file can hold, or null with no known size. The protocol stops
  // buffering a paged map past it, since the assembled list would be refused anyway.
  maxMapEntries() { return maxMapEntries(this._expectedSize, this._tier) }

  // Refuse a map the protocol stopped buffering; the peer stops counting as one that owes a map.
  refuseMapFrom(peer, reason) {
    if (this._requested.delete(peer) && !this._done) this._refuseMap(reason)
  }

  // Only a peer we asked may supply the map, and only once: answering removes it from _requested.
  // The first acceptable list starts the transfer; a later one adds a holder.
  async onChunkHashes(peer, chunks) {
    if (!this._requested.delete(peer) || this._done) return
    const fault = mapFault(chunks, { expectedSize: this._expectedSize, tier: this._tier, adopted: this._chunks })
    if (fault) return this._refuseMap(fault)
    this._peers.add(peer)
    if (!this._peerInflight.has(peer)) this._peerInflight.set(peer, 0)
    if (!this._started) return this._start(chunks)
    if (!this._settingUp) this.liveness.arm()
    this._assign()
  }

  async onChunkData(peer, index, data) {
    if (!this.awaitsChunk(peer, index)) return
    const res = this._transfer.writeChunk(this.destPath, index, data)
    // The inflight slot is freed either way: a bad chunk is re-fetched.
    this._inflight.delete(index)
    this._peerInflight.set(peer, Math.max(0, (this._peerInflight.get(peer) || 1) - 1))
    if (!res.ok) return this._chunkFailed(index, res)
    this._needed.delete(index)
    this.liveness.noteProgress()
    this.liveness.restartDebt(peer, (this._peerInflight.get(peer) || 0) > 0)
    this._received.set(peer, (this._received.get(peer) || 0) + 1)
    this._receivedBytes += (data ? data.length : 0)
    this.liveness.arm()
    if (this._onProgress) { try { this._onProgress(this._receivedBytes, this._totalBytes) } catch {} }
    this._maybeReportHave()
    if (this._needed.size === 0 && this._inflight.size === 0) return this._finalize()
    if (++this._sinceYield >= YIELD_EVERY) {
      this._sinceYield = 0
      await yieldToLoop()
      if (this._done) return
    }
    this._assign()
  }

  // A content request went out to this peer. Something is outstanding now, so the watchdog runs.
  noteRequested(peer) {
    if (this._done) return
    this._requested.add(peer)
    this.liveness.arm()
  }

  removePeer(peer) {
    const wasRequested = this._requested.delete(peer)
    this.liveness.forget(peer)
    if (!this._peers.has(peer)) {
      // It died before its list arrived; if it was the last holder we waited on, fail now.
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
      this._inflight.delete(index)
      abandoned.push(index)
    }
    // Those bytes were charged when assigned and are re-charged on re-assign.
    refundChunks(this._limiter, this._chunks, abandoned)
    if (this._done) return
    if (this._peers.size === 0 && this._requested.size === 0 && this._needed.size > 0) {
      return this._fail(new Error('all peers gone with ' + this._needed.size + ' chunk(s) outstanding'))
    }
    this._assign()
  }

  /** @internal */
  receivedFrom(peer) { return this._received.get(peer) ?? 0 }

  /** @internal */
  inflightFor(peer) { return this._peerInflight.get(peer) ?? 0 }

  /** @internal */
  sources() { return this._peers }

  /** @internal */
  get chunkMap() { return this._chunks }

  // The journal-less resume re-verify inside startReceive can run for a while and accepts no
  // chunks, so the watchdog is suppressed until setup completes — a later holder's list would
  // otherwise re-arm it and trip a healthy resume.
  async _start(chunks) {
    this._started = true
    this._settingUp = true
    this.liveness.clear()
    let offset = 0
    this._chunks = chunks.map((c) => {
      const entry = { hash: c.hash, offset, length: c.length }
      offset += c.length
      return entry
    })
    this._totalBytes = offset
    let state
    try {
      state = await this._transfer.startReceive(
        this.destPath,
        { size: offset, chunks: this._chunks, contentHash: this._contentHash },
        { isCancelled: () => this._done, onVerifyProgress: this._onVerify, parentMustExist: this._parentMustExist },
      )
    } catch (err) {
      this._settingUp = false
      if (this._done) return
      return this._fail(err)
    }
    this._settingUp = false
    if (this._done) return
    // The keep-alive reach starts here: a re-verify can run for minutes and must not spend it.
    this.liveness.noteProgress()
    this._resume(state)
    this.liveness.arm()
    if (this._needed.size === 0) return this._finalize()
    return this._assign()
  }

  // Fetch only what the partial lacks, and continue progress from the resumed offset. Holders hear
  // our resume bytes so their bars show our true progress.
  _resume(state) {
    let have = 0
    for (let i = 0; i < this._chunks.length; i++) {
      if (state.received.has(i)) have += this._chunks[i].length
      else this._needed.add(i)
    }
    this._receivedBytes = have
    if (have <= 0) return
    this._reportHave(Date.now())
    if (this._onProgress) { try { this._onProgress(this._receivedBytes, this._totalBytes) } catch {} }
  }

  // A coded failure is a local fs error: a transient one leaves the chunk needed and reassigns it;
  // any other ends the fetch carrying the code. No code is a hash or length mismatch, retried
  // elsewhere.
  _chunkFailed(index, res) {
    refundChunks(this._limiter, this._chunks, [index])
    if (res.code && !isTransientWriteCode(res.code)) return this._fail(codedError('write failed: ' + res.error, res.code))
    this._assign()
  }

  // A refused map is never a source; only when nobody is left to answer does the fetch fail.
  _refuseMap(reason) {
    if (this._peers.size === 0 && this._requested.size === 0) this._fail(new Error('chunk map rejected: ' + reason))
  }

  // Bytes this peer could legitimately be sending us right now.
  _owedBytes(peer) {
    let total = 0
    for (const [index, p] of this._inflight) {
      if (p !== peer) continue
      const len = this._chunks?.[index]?.length
      if (len > 0) total += len
    }
    return total
  }

  _assign() {
    if (this._done || !this._chunks) return
    const limiter = this._limiter && !this._limiter.isUnlimited() ? this._limiter : null
    const round = planRound({
      peers: this._peers,
      cursor: this._peerCursor,
      cap: this._cap,
      peerInflight: this._peerInflight,
      needed: this._needed,
      inflight: this._inflight,
      chunks: this._chunks,
      limiter,
    })
    this._peerCursor = round.cursor
    for (const [peer, indices] of round.batches) {
      if (!indices.length) continue
      this._sendNeed(peer, indices)
      this.liveness.anchorIfUnset(peer)
    }
    // The retry is registered BEFORE the watchdog re-evaluates: whether the limiter accepted it is
    // what separates paced (not timed) from stuck (timed).
    this._pacing = round.gated ? limiter.whenAvailable(round.gatedBytes, () => this._assign()) !== false : false
    this.liveness.arm()
  }

  // Our cumulative bytes, to the holders: once at resume, throttled as chunks land, and once at
  // finalize, so every holder's bar settles at 100% whoever served what.
  _reportHave(now) {
    if (!this._onBaseline || this._receivedBytes <= 0) return
    this._lastReportAt = now
    try { this._onBaseline(this._receivedBytes) } catch {}
  }

  _maybeReportHave() {
    if (!this._onBaseline) return
    const now = Date.now()
    if (now - this._lastReportAt >= this._reportInterval) this._reportHave(now)
  }

  async _finalize() {
    if (this._finalizing || this._done) return
    this._finalizing = true
    this._reportHave(Date.now())
    // The digest drain can outlast the idle window.
    this.liveness.clear()
    let fin
    try { fin = await this._transfer.finalize(this.destPath) } catch (err) { return this._fail(err) }
    if (!fin.ok) {
      const err = new Error('finalize failed: ' + fin.error)
      if (fin.code) Object.assign(err, { code: fin.code })
      return this._fail(err)
    }
    this._finish()
  }

  // Terminal: the watchdog stops, and our place in the limiter's queue and any budget granted but
  // never spent go back, or every remaining transfer runs below the cap.
  _end() {
    this._done = true
    this.liveness.clear()
    if (typeof this._limiter?.detach !== 'function') return
    try { this._limiter.detach() } catch {}
  }

  _fail(err) {
    if (this._done) return
    this._end()
    this._reportEnd(false, err.message)
    // Journal the hash frontier and close the fd and stash at the failure boundary, so a failure
    // that is never retried parks nothing; the partial stays for a later resume. A cancel does its
    // own pause or cancel before rejecting.
    if (this._transfer && typeof this._transfer.pause === 'function') {
      try { Promise.resolve(this._transfer.pause(this.destPath)).catch(() => {}) } catch {}
    }
    if (this._reject) this._reject(err)
  }

  _finish() {
    if (this._done) return
    this._end()
    this._reportEnd(true, 'complete')
    if (this._resolve) this._resolve({ chunksPerPeer: this._received, peerCount: this._received.size, size: this._totalBytes })
  }

  _reportEnd(ok, reason) {
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
}
