// SPDX-License-Identifier: AGPL-3.0-only
// Derived from hyper-overlay lib/protocol-v2.js @ 6cac8ee (v0.2.9), Copyright (C) 2026 the
// hyper-overlay authors, licensed AGPL-3.0. Modified for Mirall in 2026; PROVENANCE.md
// lists the changes and carries the full license notice.

// The multi-source fetches this device runs, one per content hash. A same-hash fetch joins the one
// in flight; a cancel stops only its own caller's interest, and one that arrives before that
// caller's fetch is honoured when the fetch arrives; control and progress frames go only to the
// holders we asked; chunk lists, chunks and keep-alives are taken only from a peer the hash's
// scheduler awaits them from.

import fs from 'bare-fs'
import { ChunkScheduler } from '../scheduler/scheduler.js'
import { codedError, isDestinationFault } from '../local-faults.js'
import { contentHashOf, contentPath } from '../content-path.js'
import { CONTROL_PAUSED, CONTROL_STOPPED } from '../wire/messages.js'
import { peerRxBytes } from './transport-probe.js'

/**
 * A caller's identity, `opts.by` on fetch and cancel: a cancel reaches only the fetch of the caller
 * that names the same key. Callers that pass none share the null key.
 * @typedef {string | null} CallerKey
 */

/**
 * A caller awaiting another caller's fetch. `drop` rejects its own await and nothing else.
 * @typedef {{ by: CallerKey, drop: (err: Error) => void }} Joiner
 */

/**
 * One fetch in flight, led by caller `by` into its own destination. `done` settles AFTER the
 * registry entry is removed, so a joiner that re-issues on its rejection starts a fresh fetch.
 * @typedef {{ sched: ChunkScheduler, by: CallerKey, joiners: Set<Joiner>, done: Promise<{ chunksPerPeer: Map<object, number>, peerCount: number, size: number }> }} FetchHandle
 */

export class FetchSession {
  // `pages` is the chunk-list assembler; `peers` lists the attached peers; `localProfileKey` is
  // stamped on every content request so the holder's serve gate can authenticate the asker.
  constructor({ transfer, pages, peers, downloadLimiter = null, localProfileKey = null }) {
    this._transfer = transfer
    this._pages = pages
    this._peers = peers
    this._downloadLimiter = downloadLimiter
    this._localProfileKey = localProfileKey
    /** @type {Map<string, FetchHandle>} */
    this._handles = new Map()
    // Per hash, the callers that cancelled before their fetch arrived (their peer-wait window).
    /** @type {Map<string, Set<CallerKey>>} */
    this._cancelPending = new Map()
  }

  // Fetch a file by content hash from every given peer in parallel into opts.destPath, on behalf of
  // caller opts.by.
  fetch(contentHash, peers, opts = {}) {
    const by = opts.by ?? null
    const inflight = this._handles.get(contentHash)
    if (inflight) {
      if (this._takePendingCancel(contentHash, by)) return Promise.reject(codedError('fetch cancelled', 'ECANCELLED'))
      return this._join(inflight, contentHash, peers, opts)
    }
    const synthPath = contentPath(contentHash)
    const sched = new ChunkScheduler({
      path: synthPath,
      destPath: opts.destPath,
      size: opts.size,
      parentMustExist: opts.parentMustExist,
      transfer: this._transfer,
      sendNeed: (peer, indices) => peer.msgs.chunkNeed.send({ path: synthPath, indices }),
      cap: opts.cap,
      timeout: opts.timeout,
      onProgress: opts.onProgress,
      onVerify: opts.onVerify,
      onEnd: opts.onEnd,
      onBaseline: (have) => this.sendProgress(contentHash, have),
      contentHash,
      // Its own stream on the shared bucket: the limiter shares the cap between streams, and a
      // scheduler racing the bucket directly would starve every transfer waiting its turn.
      limiter: this._downloadLimiter ? this._downloadLimiter.stream() : null,
      peerBytes: peerRxBytes,
    })
    /** @type {FetchHandle} */
    const handle = { sched, by, joiners: new Set(), done: sched.promise().finally(() => this._handles.delete(contentHash)) }
    this._handles.set(contentHash, handle)
    // A finished or failed fetch has no holder left to tell about it; a paused or cancelled one
    // keeps them until its STOPPED goes out.
    const forgetAsked = () => { for (const peer of peers) peer.askedFor.delete(contentHash) }
    handle.done.then(forgetAsked, (err) => { if (err?.code !== 'ECANCELLED') forgetAsked() })
    if (this._takePendingCancel(contentHash, by)) { sched.cancel(); return handle.done }
    for (const peer of peers) {
      // Noted before asking, so losing the peer before its chunk list arrives fails the fetch fast.
      sched.noteRequested(peer)
      this._ask(peer, contentHash)
    }
    return handle.done
  }

  // Stop caller `by`'s fetch. The leader's cancel stops the scheduler: discardPartial unlinks the
  // partial (cancel); otherwise it is kept for resume (pause). Holders hear about it first, so their
  // indicator reacts now; signal:false suppresses that (a supersede is a restart, not a user stop).
  // Its joiners then re-issue their own fetch, since the partial belongs to the leader's
  // destination. A joiner's cancel only ends its own await: the leader keeps fetching, and the
  // joiner has no partial or holder of its own to tell. A caller with no fetch here yet never asked
  // anyone, so only its intent is recorded.
  async cancel(contentHash, { by = null, discardPartial = false, signal = true } = {}) {
    const handle = this._handles.get(contentHash)
    if (handle?.by !== by) return this._dropJoiner(handle, contentHash, by)
    if (signal) this._sendControl(contentHash, discardPartial ? CONTROL_STOPPED : CONTROL_PAUSED)
    // Stop accepting chunks first, so the pause's hash drain converges on a stable frontier.
    handle.sched.cancel()
    if (discardPartial) this._transfer.cancel(handle.sched.destPath)
    else await this._transfer.pause(handle.sched.destPath)
    return true
  }

  // Tell holders we stopped pulling a hash whose local fetch is already gone. While any caller still
  // fetches it, the holders are serving that fetch, so nothing goes out.
  sendStop(contentHash) {
    if (!this._handles.has(contentHash)) this._sendControl(contentHash, CONTROL_STOPPED)
  }

  // Our on-disk bytes for a hash we are fetching, so holders' bars show our true progress.
  sendProgress(contentHash, have) { this._sendToAsked('transferProgress', { contentHash, have }) }

  // A fetch abandoned before it ever asked (no holder connected): its pre-scheduler cancel must not
  // cancel the next fetch of the same content.
  clearCancelPending(contentHash, by = null) { this._takePendingCancel(contentHash, by) }

  // A map is taken only from a peer its scheduler asked, and checked before a page is buffered. A
  // refused page also discards what the peer buffered for the path: those pages answered a fetch
  // that has stopped awaiting them. A map past its size-derived bound is refused like an oversized
  // list; a peer past its own page budget is dropped, and its close takes it out of every fetch.
  async onChunkHashes(peer, msg) {
    const sched = this._handles.get(contentHashOf(msg.path))?.sched
    if (!sched || !sched.awaitsMapFrom(peer)) {
      this._pages.drop(peer, msg.path)
      return
    }
    const overflow = this._pages.overflow(peer, msg, () => sched.maxMapEntries())
    if (overflow === 'map') {
      this._pages.drop(peer, msg.path)
      sched.refuseMapFrom(peer, 'too many chunks')
      return
    }
    if (overflow === 'peer') {
      this._pages.forget(peer)
      peer.channel.close()
      return
    }
    const chunks = this._pages.take(peer, msg)
    // A buffered page is forward progress while a large map streams across frames.
    if (chunks === null) return sched.notePageProgress?.()
    return sched.onChunkHashes(peer, chunks)
  }

  // A chunk is taken only by the scheduler that has it in flight to this peer.
  onChunkData(peer, msg) {
    const sched = this._handles.get(contentHashOf(msg.path))?.sched
    if (!sched || !sched.awaitsChunk(peer, msg.index)) return
    return sched.onChunkData(peer, msg.index, msg.data)
  }

  // A holder is parked on its own upload cap; its scheduler decides whether that earns a re-arm.
  onKeepAlive(peer, msg) {
    this._handles.get(msg.contentHash)?.sched.notePeerAlive(peer, msg.index)
  }

  // Failover: each fetch reassigns this peer's inflight chunks to the remaining peers.
  removePeer(peer) {
    for (const { sched } of this._handles.values()) sched.removePeer(peer)
  }

  get size() { return this._handles.size }

  /** @internal */
  get(contentHash) { return this._handles.get(contentHash) }

  /** @internal */
  adoptForTests(contentHash, sched) {
    this._handles.set(contentHash, { sched, by: null, joiners: new Set(), done: new Promise(() => {}) })
  }

  // A concurrent fetch of the same bytes awaits the verified file and copies it to its own
  // destination. If the leader was cancelled or failed on its own destination, it re-issues its
  // own fetch. A joiner dropped by its own cancel does neither.
  _join(inflight, contentHash, peers, opts) {
    /** @type {Joiner} */
    const joiner = { by: opts.by ?? null, drop: () => {} }
    const dropped = new Promise((_resolve, reject) => { joiner.drop = reject })
    inflight.joiners.add(joiner)
    const shared = inflight.done.then(
      (res) => {
        if (!inflight.joiners.delete(joiner)) return res
        if (opts.destPath && opts.destPath !== inflight.sched.destPath) fs.copyFileSync(inflight.sched.destPath, opts.destPath)
        return res
      },
      (err) => {
        if (!inflight.joiners.delete(joiner)) throw err
        if (err?.code === 'ECANCELLED' || isDestinationFault(err)) return this.fetch(contentHash, peers, opts)
        throw err
      },
    )
    return Promise.race([dropped, shared])
  }

  // A cancel from a caller that is not leading: a joiner stops awaiting; a caller whose fetch has
  // not arrived yet has its cancel recorded for when it does.
  _dropJoiner(handle, contentHash, by) {
    const joiner = handle && [...handle.joiners].find((j) => j.by === by)
    if (!joiner) {
      const callers = this._cancelPending.get(contentHash) ?? new Set()
      this._cancelPending.set(contentHash, callers.add(by))
      return false
    }
    handle.joiners.delete(joiner)
    joiner.drop(codedError('fetch cancelled', 'ECANCELLED'))
    return true
  }

  _takePendingCancel(contentHash, by) {
    const callers = this._cancelPending.get(contentHash)
    if (!callers?.delete(by)) return false
    if (callers.size === 0) this._cancelPending.delete(contentHash)
    return true
  }

  _ask(peer, contentHash) {
    peer.askedFor.add(contentHash)
    peer.msgs.contentRequest.send({ contentHash, chunksHave: null, from: this._localProfileKey || '' })
  }

  _sendControl(contentHash, state) {
    this._sendToAsked('transferControl', { contentHash, state })
    if (state === CONTROL_STOPPED) for (const peer of this._peers()) peer.askedFor.delete(contentHash)
  }

  // Best-effort, per peer: a closing channel or an old peer without the slot cannot throw.
  _sendToAsked(msgName, payload) {
    for (const peer of this._peers()) {
      if (!peer.askedFor.has(payload.contentHash)) continue
      try { peer.msgs[msgName]?.send(payload) } catch {}
    }
  }
}
