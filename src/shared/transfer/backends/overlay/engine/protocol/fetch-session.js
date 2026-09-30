// SPDX-License-Identifier: AGPL-3.0-only
// Derived from hyper-overlay lib/protocol-v2.js @ 6cac8ee (v0.2.9), Copyright (C) 2026 the
// hyper-overlay authors, licensed AGPL-3.0. Modified for Mirall in 2026; PROVENANCE.md
// lists the changes and carries the full license notice.

// The multi-source fetches this device runs, one per content hash. A same-hash fetch joins the one
// in flight; a cancel that arrives before the scheduler exists is honoured when it is created;
// control and progress frames go only to the holders we asked; chunk lists, chunks and keep-alives
// are taken only from a peer the hash's scheduler awaits them from.

import fs from 'bare-fs'
import { ChunkScheduler } from '../scheduler/scheduler.js'
import { isDestinationFault } from '../local-faults.js'
import { contentHashOf, contentPath } from '../content-path.js'
import { CONTROL_PAUSED, CONTROL_STOPPED } from '../wire/messages.js'
import { peerRxBytes } from './transport-probe.js'

/**
 * One fetch in flight. `done` settles AFTER the registry entry is removed, so a joiner that
 * re-issues on its rejection starts a fresh fetch.
 * @typedef {{ sched: ChunkScheduler, done: Promise<{ chunksPerPeer: Map<object, number>, peerCount: number, size: number }> }} FetchHandle
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
    // Hashes cancelled before their scheduler existed (the caller's peer-wait window).
    this._cancelPending = new Set()
  }

  // Fetch a file by content hash from every given peer in parallel into opts.destPath.
  fetch(contentHash, peers, opts = {}) {
    const inflight = this._handles.get(contentHash)
    if (inflight) return this._join(inflight, contentHash, peers, opts)
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
    const handle = { sched, done: sched.promise().finally(() => this._handles.delete(contentHash)) }
    this._handles.set(contentHash, handle)
    // A finished or failed fetch has no holder left to tell about it; a paused or cancelled one
    // keeps them until its STOPPED goes out.
    const forgetAsked = () => { for (const peer of peers) peer.askedFor.delete(contentHash) }
    handle.done.then(forgetAsked, (err) => { if (err?.code !== 'ECANCELLED') forgetAsked() })
    if (this._cancelPending.delete(contentHash)) { sched.cancel(); return handle.done }
    for (const peer of peers) {
      // Noted before asking, so losing the peer before its chunk list arrives fails the fetch fast.
      sched.noteRequested(peer)
      this._ask(peer, contentHash)
    }
    return handle.done
  }

  // Stop a fetch. discardPartial unlinks the partial (cancel); otherwise it is kept for resume
  // (pause). Holders hear about it first, so their indicator reacts now; signal:false suppresses
  // that (a supersede is a restart, not a user stop). Without a scheduler the fetch never asked
  // anyone, so only the intent is recorded.
  async cancel(contentHash, { discardPartial = false, signal = true } = {}) {
    const handle = this._handles.get(contentHash)
    if (!handle) { this._cancelPending.add(contentHash); return false }
    if (signal) this._sendControl(contentHash, discardPartial ? CONTROL_STOPPED : CONTROL_PAUSED)
    // Stop accepting chunks first, so the pause's hash drain converges on a stable frontier.
    handle.sched.cancel()
    if (discardPartial) this._transfer.cancel(handle.sched.destPath)
    else await this._transfer.pause(handle.sched.destPath)
    return true
  }

  // Tell holders we stopped pulling a hash whose local fetch is already gone.
  sendStop(contentHash) { this._sendControl(contentHash, CONTROL_STOPPED) }

  // Our on-disk bytes for a hash we are fetching, so holders' bars show our true progress.
  sendProgress(contentHash, have) { this._sendToAsked('transferProgress', { contentHash, have }) }

  // A fetch abandoned before it ever asked (no holder connected): its pre-scheduler cancel must not
  // cancel the next fetch of the same content.
  clearCancelPending(contentHash) { this._cancelPending.delete(contentHash) }

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
    this._handles.set(contentHash, { sched, done: new Promise(() => {}) })
  }

  // A concurrent fetch of the same bytes awaits the verified file and copies it to its own
  // destination. If the leader was cancelled or failed on its own destination, it re-issues its
  // own fetch.
  _join(inflight, contentHash, peers, opts) {
    return inflight.done.then(
      (res) => {
        if (opts.destPath && opts.destPath !== inflight.sched.destPath) fs.copyFileSync(inflight.sched.destPath, opts.destPath)
        return res
      },
      (err) => {
        if (err?.code === 'ECANCELLED' || isDestinationFault(err)) return this.fetch(contentHash, peers, opts)
        throw err
      },
    )
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
