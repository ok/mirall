/**
 * OverlayProtocolV2 — Protomux channel for sync + transfer
 *
 * Sync approach: each side sends its local feed entries directly via
 * file-offer messages. No Hypercore feed replication needed — the feed
 * entries are small JSON objects sent over our own Protomux channel.
 *
 * Flow:
 *  1. Channel opens → both send sync-state (feed length)
 *  2. Side with more entries sends file-offers for each change
 *  3. Receiver auto-requests files it doesn't have
 *  4. Sender chunks on demand → streams chunks → receiver writes to disk
 */

import path from 'bare-path'
import * as messages from './messages-v2.js'
import { hashChunk, selectTier } from './chunker.js'
import { ChunkScheduler } from './chunk-scheduler.js'
import fs from 'bare-fs'

const PROTOCOL = 'hyper-overlay/v2'
const VERSION = 2
const CAP_LOCAL_FILES = 0x01
const CAP_ADAPTIVE_CHUNKS = 0x02

// [mirall] §4.12 — a file's chunk list, shipped in one frame, can exceed the
// 16 MiB-1 Noise transport limit (@hyperswarm/secret-stream MAX_ATOMIC_WRITE):
// a 1.25 TB file at tier 3 is ~1.2M entries ≈ ~44 MB, which the secret-stream
// rejects ("Message is too large for an atomic write"), dropping the connection
// before a byte ships. So chunkHashes is paged into frames of ≤ this many
// entries. Each wire entry is 32 B (hash) + ≤5 B (varint length) ≈ 37 B, so
// 100k entries ≈ 3.7 MB/frame — well under the limit even after Protomux's
// ≤8 MiB send-batching.
const MAX_CHUNKS_PER_MSG = 100000

// [mirall] §4.15 — tree entries are variable length (name is a var-string), unlike the
// fixed-width chunkHashes entries, so treeResponse pages by an encoded-byte budget rather
// than a fixed count. 4 MiB keeps each frame well under the atomic-write limit even after
// Protomux's ≤8 MiB send-batching.
const MAX_TREE_BYTES_PER_MSG = 4 * 1024 * 1024

// [mirall] §4.15 — defensive ceiling on the bytes a requester will accumulate across a
// paged treeResponse. A single-directory tree is orders of magnitude smaller; this only
// bounds memory so a peer streaming pages endlessly rejects the request instead of OOMing.
const MAX_TREE_RESPONSE_BYTES = 256 * 1024 * 1024

// transfer-control (message 12) states, downloader→holder.
const CONTROL_PAUSED = 0
const CONTROL_STOPPED = 1

// [mirall] §HOL — abandon a serve loop whose stream neither drains nor closes within
// this window (a wedged-but-TCP-alive peer); the receiver re-requests, so it self-heals.
const DRAIN_TIMEOUT_MS = 60000

export class OverlayProtocolV2 {
  constructor (syncEngine, transferManager, opts = {}) {
    this._syncEngine = syncEngine
    this._transferManager = transferManager
    this._corestore = opts.corestore || null
    this._overlayKey = opts.key || null
    this._peers = new Map()
    this._filePaths = opts.filePaths || new Map()
    this._syncBaseDirs = opts.syncBaseDirs || []
    this._defaultStrategy = opts.defaultStrategy || 'prompt'
    this._autoSync = opts.autoSync !== false

    this._conflictCb = opts.onConflict || null
    this._syncedCb = opts.onSynced || null
    this._fileOfferCb = opts.onFileOffer || null
    // Called for every chunk that arrives on this peer. Lets callers
    // (e.g. NetworkFetcher) implement silent-peer watchdogs by resetting
    // an idle timer on every chunk. Receives { path, index, bytes, peer }.
    this._chunkProgressCb = opts.onChunkProgress || null
    // [mirall] serve-side telemetry, symmetric to onChunkProgress — fired when WE
    // serve a peer (the sender-side download indicator). onServeStart({ path, peer,
    // from, total }) once a peer is authorized to fetch; onChunkServe({ path, peer,
    // from, bytes }) per served chunk; onServeEnd({ path, peer, from }) on close.
    this._serveStartCb = opts.onServeStart || null
    this._chunkServeCb = opts.onChunkServe || null
    this._serveEndCb = opts.onServeEnd || null
    // [mirall] Content-plane transfer caps, injected by the app layer so this module keeps
    // no app imports. Absent → unthrottled.
    this._uploadLimiter = opts.uploadLimiter || null
    this._downloadLimiter = opts.downloadLimiter || null
    // [mirall] Serve grants are cached per (peer, syntheticPath) at request time and every later
    // chunkNeed is checked against that cache alone, so a request-time authorization would
    // otherwise be trusted forever. The epoch moves on any membership/space mutation, which
    // forces ONE re-authorization per (peer, path) — not one per chunk, so the hot path stays a
    // map lookup. bumpServeEpoch() is the app's "re-check who is still entitled" signal.
    this._serveEpoch = 0
    // A downloader paused/stopped a hash WE serve. { path, peer, from, state }.
    this._serveControlCb = opts.onServeControl || null
    // A downloader reported its on-disk have-bytes for a hash WE serve (resume
    // baseline). { path, peer, from, have }.
    this._serveProgressCb = opts.onServeProgress || null

    // 0.5a: content-hash → local disk path, for responding to content-requests
    this._contentHashPaths = opts.contentHashPaths || new Map()
    // 0.5a: tree-request timeout (ms)
    this._treeRequestTimeout = opts.treeRequestTimeout || 30000
    // [mirall] §4.15 — cap on bytes accumulated across a paged treeResponse
    this._maxTreeResponseBytes = opts.maxTreeResponseBytes || MAX_TREE_RESPONSE_BYTES
    // Multi-source: synthetic path 'content:<hash>' → ChunkScheduler. When set,
    // _onChunkHashes/_onChunkData delegate to the scheduler (parallel fetch
    // across peers) instead of the legacy single-peer auto-flow.
    this._schedulers = new Map()
    // [mirall] 'content:<hash>' cancelled before its scheduler existed (the caller's
    // peer-wait window) — fetchContent honors it the moment it creates the scheduler.
    this._cancelPending = new Set()

    // [mirall] serve authorization. _serveAuthorizer(peer, from, hash) →
    // boolean gates every inbound content-request; deny is a silent drop
    // (indistinguishable from "I don't hold it" — no membership oracle).
    // _localProfileKey is stamped on outbound content-requests as msg.from.
    this._serveAuthorizer = opts.serveAuthorizer || null
    this._localProfileKey = opts.localProfileKey || null
  }

  /**
   * Multi-source fetch of a file by content hash from several peers in
   * parallel (torrent-style). The caller pre-registers _filePaths['content:'
   * + contentHash] = destPath. Resolves when the file is assembled + verified.
   *
   * @param {string} contentHash
   * @param {Array} peers peer objects to fan the request to
   * @param {object} [opts] { destPath, cap, timeout, onProgress }
   * @returns {Promise<void>}
   */
  fetchContent (contentHash, peers, opts = {}) {
    const p = 'content:' + contentHash
    // [mirall] Content-addressed dedup: a concurrent fetch of the SAME hash (a
    // different file/transfer with identical bytes) joins the in-flight one instead
    // of failing — await its verified bytes, then copy to our destPath. If the leader
    // was cancelled, re-issue our own fetch (the scheduler entry is already gone).
    const inflight = this._schedulers.get(p)
    if (inflight) {
      return inflight.shared.then(
        (res) => {
          if (opts.destPath && opts.destPath !== inflight.destPath) {
            try { fs.copyFileSync(inflight.destPath, opts.destPath) } catch (err) { throw err }
          }
          return res
        },
        (err) => { if (err?.code === 'ECANCELLED') return this.fetchContent(contentHash, peers, opts); throw err },
      )
    }
    const sched = new ChunkScheduler({
      path: p,
      destPath: opts.destPath,
      transfer: this._transferManager,
      sendNeed: (peer, indices) => peer.msgs.chunkNeed.send({ path: p, indices }),
      cap: opts.cap,
      timeout: opts.timeout,
      onProgress: opts.onProgress,
      onVerify: opts.onVerify,
      onEnd: opts.onEnd,
      onBaseline: (have) => this.sendTransferProgress(contentHash, have),
      contentHash,   // [mirall] verify the whole-file hash incrementally during the transfer
      // [mirall] Download cap. Its OWN stream on the shared bucket: the limiter shares the
      // cap fairly between streams, and a scheduler that raced the bucket directly would
      // starve every transfer that is waiting its turn.
      limiter: this._downloadLimiter ? this._downloadLimiter.stream() : null
    })
    this._schedulers.set(p, sched)
    // [mirall] shared promise so joiners (above) can await the same completion —
    // calling sched.promise() twice would overwrite its resolve/reject handlers.
    sched.shared = sched.promise().finally(() => this._schedulers.delete(p))
    // [mirall] honor a cancel/pause that arrived before this scheduler existed.
    if (this._cancelPending.delete(p)) { sched.cancel(); return sched.shared }
    for (const peer of peers) {
      sched.noteRequested(peer) // [mirall] so losing it before its chunk list arrives fails the fetch fast
      this.requestContent(peer, contentHash, null)
    }
    return sched.shared
  }

  // [mirall] Stop an in-flight multi-source fetch. discardPartial:true unlinks the
  // partial (cancel); false keeps it for resume (pause). The scheduler's promise
  // rejects with ECANCELLED and its .finally() removes it from _schedulers. When no
  // scheduler exists yet (the caller is still in its peer-wait window), remember the
  // intent so fetchContent cancels the scheduler the instant it is created.
  async cancelContent (contentHash, { discardPartial = false, signal = true } = {}) {
    const p = 'content:' + contentHash
    const sched = this._schedulers.get(p)
    // No scheduler → the fetch never sent a content-request, so no holder has a serve
    // row for us; skip the (wasted) broadcast and just record the pre-scheduler cancel.
    if (!sched) { this._cancelPending.add(p); return false }
    // Tell holders we paused (keep partial) or stopped (discard) BEFORE local teardown,
    // so their sender-side indicator reacts now, not after the idle sweep. signal:false
    // suppresses it (a supersede is a restart, not a user stop).
    if (signal) this._sendTransferControl(contentHash, discardPartial ? CONTROL_STOPPED : CONTROL_PAUSED)
    // Stop accepting chunks first so the pause hash-drain converges on a stable frontier.
    sched.cancel()
    if (discardPartial) this._transferManager.cancel(sched.destPath)
    else await this._transferManager.pause(sched.destPath)
    return true
  }

  // Tell holders we stopped pulling a hash whose local fetch is already gone (e.g.
  // discarding an already-paused transfer) — no scheduler to tear down here.
  sendStopControl (contentHash) { this._sendTransferControl(contentHash, CONTROL_STOPPED) }

  // Best-effort broadcast to all connected holders. A holder with no serve-ledger entry
  // for us (or no slot for this message) just drops it; wrapped per-peer so a closing
  // channel or an old peer can't throw.
  _broadcast (msgName, payload) {
    for (const [, peer] of this._peers) {
      try { peer.msgs[msgName]?.send(payload) } catch {}
    }
  }

  _sendTransferControl (contentHash, state) { this._broadcast('transferControl', { contentHash, state }) }

  // Tell holders our current on-disk have-bytes for a hash we're (re)fetching, so their
  // sender-side bar mirrors our TRUE progress rather than only the bytes they re-serve.
  sendTransferProgress (contentHash, have) { this._broadcast('transferProgress', { contentHash, have }) }

  // [mirall] Drop a cancel recorded before a scheduler existed when the fetch is
  // abandoned without ever reaching fetchContent (no peer connected) — otherwise the
  // marker would cancel the next fetch of the same content.
  clearCancelPending (contentHash) { this._cancelPending.delete('content:' + contentHash) }

  setContentHashPaths (map) { this._contentHashPaths = map }

  attach (mux) {
    if (this._peers.has(mux)) return this._peers.get(mux)

    const self = this

    const channel = mux.createChannel({
      protocol: PROTOCOL,
      id: this._overlayKey || null,
      onopen () {
        const peer = self._peers.get(mux)
        if (peer) self._onOpen(peer)
      },
      onclose () {
        const peer = self._peers.get(mux)
        self._peers.delete(mux)
        // [mirall] Drop this peer's upload-cap handle: it resolves any serve loop parked on
        // take() with 0 (so it returns instead of sending to a dead channel) and hands back
        // budget charged for bytes that will never go out.
        if (peer?.uploadStream) { try { peer.uploadStream.detach() } catch {} ; peer.uploadStream = null }
        // Failover: let any active multi-source fetch reassign this peer's
        // inflight chunks to the remaining peers.
        if (peer) for (const sched of self._schedulers.values()) sched.removePeer(peer)
        // [mirall] §4.15 — fail in-flight tree requests now, so a mid-stream disconnect
        // rejects promptly instead of stranding the request (and its buffered pages)
        // until the idle timeout fires.
        if (peer) self._failPendingTrees(peer, new Error('channel closed'))
        // [mirall] tell the sender-side indicator this peer is gone for every file
        // it was pulling, so a disconnect mid-download clears its row promptly.
        if (peer && self._serveEndCb) {
          for (const [synthPath, grant] of peer.authorizedServe) {
            try { self._serveEndCb({ path: synthPath, peer, from: grant?.from ?? null }) } catch {}
          }
        }
      }
    })

    if (!channel) return null

    const peer = {
      mux, channel, remoteFeedKey: null, remoteSeq: 0, msgs: {},
      pendingTrees: new Map(), // hash → { resolve, reject, timer, timeout, nonce, pages, pageBytes }
      // [mirall] synthetic serve-paths this peer was authorized for via a
      // GATED _onContentRequest, mapped to the requester profileKey (msg.from).
      // _onChunkNeed serves bytes only for paths in here, so a peer cannot pull
      // bytes by sending chunkNeed/fileRequest directly for a registered path it
      // was never authorized to fetch; the value flows the requester identity to
      // the serve telemetry.
      authorizedServe: new Map(),
      // [mirall] Lazily-created upload-cap handle — see _uploadStreamFor.
      uploadStream: null
    }

    peer.msgs.syncState = channel.addMessage({ encoding: messages.syncState, onmessage: (msg) => self._onSyncState(peer, msg) })
    peer.msgs.fileOffer = channel.addMessage({ encoding: messages.fileOffer, onmessage: (msg) => self._onFileOffer(peer, msg) })
    peer.msgs.fileRequest = channel.addMessage({ encoding: messages.fileRequest, onmessage: (msg) => self._onFileRequest(peer, msg) })
    peer.msgs.chunkHashes = channel.addMessage({ encoding: messages.chunkHashes, onmessage: (msg) => self._onChunkHashes(peer, msg) })
    peer.msgs.chunkNeed = channel.addMessage({ encoding: messages.chunkNeed, onmessage: (msg) => self._onChunkNeed(peer, msg) })
    peer.msgs.chunkData = channel.addMessage({ encoding: messages.chunkData, onmessage: (msg) => self._onChunkData(peer, msg) })
    peer.msgs.chunkCancel = channel.addMessage({ encoding: messages.chunkCancel, onmessage: (msg) => self._onChunkCancel(peer, msg) })
    peer.msgs.transferComplete = channel.addMessage({ encoding: messages.transferComplete, onmessage: (msg) => self._onTransferComplete(peer, msg) })
    peer.msgs.conflict = channel.addMessage({ encoding: messages.conflict, onmessage: (msg) => self._onConflictMsg(peer, msg) })

    // 0.5a — tree messages (backward-compatible additions)
    peer.msgs.treeRequest = channel.addMessage({ encoding: messages.treeRequest, onmessage: (msg) => self._onTreeRequest(peer, msg) })
    peer.msgs.treeResponse = channel.addMessage({ encoding: messages.treeResponse, onmessage: (msg) => self._onTreeResponse(peer, msg) })
    peer.msgs.contentRequest = channel.addMessage({ encoding: messages.contentRequest, onmessage: (msg) => self._onContentRequest(peer, msg) })
    // Appended-last slots: ids 0-11 stay fixed for peers without 12/13, which just
    // never register these channels and ignore the frames.
    peer.msgs.transferControl = channel.addMessage({ encoding: messages.transferControl, onmessage: (msg) => self._onTransferControl(peer, msg) })
    peer.msgs.transferProgress = channel.addMessage({ encoding: messages.transferProgress, onmessage: (msg) => self._onTransferProgress(peer, msg) })

    this._peers.set(mux, peer)
    channel.open({ version: VERSION, capabilities: CAP_LOCAL_FILES | CAP_ADAPTIVE_CHUNKS })
    return peer
  }

  detach (mux) {
    const peer = this._peers.get(mux)
    if (!peer) return
    peer.channel.close()
    this._peers.delete(mux)
  }

  setFilePaths (map) { this._filePaths = map }

  broadcastOffer (overlayPath, meta, op) {
    const msg = {
      path: overlayPath,
      contentHash: meta.contentHash || '0'.repeat(64),
      size: meta.size || 0,
      mtime: meta.mtime || 0,
      op
    }
    for (const [, peer] of this._peers) {
      peer.msgs.fileOffer.send(msg)
    }
  }

  requestFile (peer, overlayPath, contentHash, chunksHave) {
    peer.msgs.fileRequest.send({
      path: overlayPath,
      contentHash,
      chunksHave: chunksHave || null
    })
  }

  /**
   * 0.5a: Request a tree by its hash. Returns a promise resolving to
   * the entries array (or [] if the peer doesn't have it).
   *
   * @param {object} peer
   * @param {string} hash - hex tree hash
   * @param {object} [opts]
   * @param {number} [opts.timeout] - override default timeout (ms)
   * @returns {Promise<Array<{kind, exec, name, childHash, size}>>}
   */
  requestTree (peer, hash, opts = {}) {
    return new Promise((resolve, reject) => {
      // If a prior request is already in-flight for the same hash, reject
      // this caller rather than silently overwrite.
      if (peer.pendingTrees.has(hash)) {
        return reject(new Error('tree request already pending for hash: ' + hash))
      }
      // [mirall] §4.15 — per-request nonce (per-peer monotonic, non-zero) lets the
      // requester drop pages echoed for a superseded attempt. pages/pageBytes buffer
      // this request's own paged response, so a fresh attempt never inherits an old one.
      const nonce = peer._treeReqSeq = (peer._treeReqSeq || 0) + 1
      const timeout = opts.timeout || this._treeRequestTimeout
      const pending = { resolve, reject, timer: null, timeout, nonce, pages: null, pageBytes: 0 }
      this._armTreeTimeout(peer, hash, pending)
      peer.pendingTrees.set(hash, pending)
      peer.msgs.treeRequest.send({ hash, nonce })
    })
  }

  // [mirall] §4.15 — arm (or re-arm) a pending tree request's idle timeout. Every buffered
  // page re-arms it (a large tree on a slow link mustn't time out mid-stream); the request
  // still settles because the accumulator is byte-capped in _onTreeResponse.
  _armTreeTimeout (peer, hash, pending) {
    pending.timer = setTimeout(() => {
      if (peer.pendingTrees.get(hash) === pending) {
        peer.pendingTrees.delete(hash)
        pending.reject(new Error('tree request timed out: ' + hash))
      }
    }, pending.timeout)
  }

  // [mirall] §4.15 — reject every in-flight tree request on this peer (channel close /
  // destroy), clearing timers so the promise fails promptly and its buffered pages release.
  _failPendingTrees (peer, err) {
    for (const [hash, pending] of peer.pendingTrees) {
      clearTimeout(pending.timer)
      peer.pendingTrees.delete(hash)
      pending.reject(err)
    }
  }

  /**
   * 0.5a: Request a file by its content hash. Peer looks up any file
   * matching that hash locally and streams chunks via the existing flow
   * (chunkHashes → chunkNeed → chunkData). Returns immediately; chunks
   * arrive asynchronously.
   *
   * Note: receiver must pre-register a target path mapping via
   * _filePaths keyed by the contentHash before calling, OR this method
   * is a no-op on the receive side. Full wiring deferred to 0.5c.
   */
  requestContent (peer, contentHash, chunksHave) {
    peer.msgs.contentRequest.send({
      contentHash,
      chunksHave: chunksHave || null,
      from: this._localProfileKey || ''   // [mirall] §4.1 — authenticate the asker
    })
  }

  get peerCount () { return this._peers.size }

  destroy () {
    for (const [, peer] of this._peers) {
      this._failPendingTrees(peer, new Error('protocol destroyed'))
      peer.channel.close()
    }
    this._peers.clear()
  }

  // ── Handlers ────────────────────────────────────────────────

  _onOpen (peer) {
    peer.msgs.syncState.send({
      feedKey: this._syncEngine.feedKey,
      localSeq: this._syncEngine.feed.length,
      remoteSeq: 0
    })
  }

  async _onSyncState (peer, msg) {
    peer.remoteFeedKey = msg.feedKey
    peer.remoteSeq = msg.localSeq

    if (!this._autoSync) return

    try {
      await this._offerLocalFiles(peer)
    } catch {
      // ignore — autoSync is off in the mirall facade, so this path is dormant
    }
  }

  async _onFileOffer (peer, msg) {
    // [mirall] Mirall's overlay flow is contentRequest→scheduler ONLY; it
    // never consumes path-based file-offers (autoSync is off). Ignoring them
    // closes the offer→requestFile→legacy-receive path a peer could drive.
    if (this._serveAuthorizer) return
    if (this._fileOfferCb) this._fileOfferCb(peer, msg)

    if (msg.op === 0) {
      const local = await this._syncEngine._fileIndex.getFile(msg.path)
      if (!local || local.contentHash !== msg.contentHash) {
        const diskPath = this._resolveFilePath(msg.path)
        if (diskPath) {
          this._filePaths.set(msg.path, diskPath)
          this.requestFile(peer, msg.path, msg.contentHash)
        }
      }
    }
  }

  async _onFileRequest (peer, msg) {
    // [mirall] path-based serve is UNGATED and would bypass the membership
    // serve gate (the only gated entry point is _onContentRequest). Mirall
    // consumers never send fileRequest, so refuse it outright in mirall mode.
    if (this._serveAuthorizer) return
    const diskPath = this._filePaths.get(msg.path)
    if (!diskPath) return

    const prepared = await this._transferManager.prepareFile(diskPath, msg.path)
    if (!prepared) return

    if (!await this._transferManager._fileIndex.hasChunkMap(msg.path)) {
      await this._transferManager._fileIndex.putChunkMap(msg.path, prepared.chunks)
    }

    this._sendChunkHashes(peer, msg.path, prepared.tier, prepared.chunks)
  }

  // [mirall] §4.12 — send a file's chunk list, paged so no single frame exceeds
  // the Noise transport's 16 MiB-1 atomic-write limit. A list that fits in one
  // frame ships as one (more:0) — identical on the wire to the pre-paging format
  // bar a trailing 0 byte. _onChunkHashes reassembles the pages on the receiver.
  _sendChunkHashes (peer, filePath, tier, chunks) {
    const total = chunks.length
    if (total <= MAX_CHUNKS_PER_MSG) {
      peer.msgs.chunkHashes.send({ path: filePath, tier, chunks, more: 0 })
      return
    }
    for (let i = 0; i < total; i += MAX_CHUNKS_PER_MSG) {
      const more = i + MAX_CHUNKS_PER_MSG < total ? 1 : 0
      peer.msgs.chunkHashes.send({ path: filePath, tier, chunks: chunks.slice(i, i + MAX_CHUNKS_PER_MSG), more })
    }
  }

  // [mirall] §4.12 — reassemble a paged chunk list. Returns the full list once
  // the final page (more:0) arrives, or null while pages are still pending. A
  // lone complete frame passes straight through (no copy) — the small-file norm.
  // Pages for a path arrive in order on this channel, so arrival-order
  // concatenation is correct even when several files interleave on it.
  _reassembleChunkHashes (peer, msg) {
    const buffered = peer._chunkHashPages && peer._chunkHashPages.get(msg.path)
    if (!buffered && !msg.more) return msg.chunks
    if (!peer._chunkHashPages) peer._chunkHashPages = new Map()
    let acc = buffered
    if (!acc) { acc = []; peer._chunkHashPages.set(msg.path, acc) }
    for (const ch of msg.chunks) acc.push(ch)
    if (msg.more) return null
    peer._chunkHashPages.delete(msg.path)
    return acc
  }

  // [mirall] §4.15 — upper-bound wire size of one tree entry: kind(1)+exec(1) +
  // string(len-prefix ≤4 + utf8 name bytes) + childHash(32) + size varint(≤9, c.uint is
  // 9 bytes for a >4 GiB size).
  _treeEntryWireSize (e) {
    return 1 + 1 + 4 + Buffer.byteLength(e.name || '', 'utf8') + 32 + 9
  }

  // [mirall] §4.15 — send a tree's entries, paged so no single frame exceeds the Noise
  // atomic-write limit; every page but the last is more:1. A tree that fits in one frame
  // ships as a single more:0 frame. `nonce` echoes the requester's per-request id.
  _sendTreeResponse (peer, hash, entries, nonce) {
    let page = []
    let bytes = 40 // hash(32) + uint32 count prefix + more/nonce + slack
    for (const e of entries) {
      const sz = this._treeEntryWireSize(e)
      if (page.length && bytes + sz > MAX_TREE_BYTES_PER_MSG) {
        peer.msgs.treeResponse.send({ hash, entries: page, more: 1, nonce })
        page = []
        bytes = 40
      }
      page.push(e)
      bytes += sz
    }
    peer.msgs.treeResponse.send({ hash, entries: page, more: 0, nonce })
  }

  async _onChunkHashes (peer, msg) {
    // [mirall] §4.12 — reassemble paged chunkHashes frames before dispatching.
    const chunks = this._reassembleChunkHashes(peer, msg)
    if (chunks === null) {
      // A buffered page is forward progress — keep the scheduler's no-progress
      // watchdog from tripping while a large map streams across several frames.
      const pending = this._schedulers.get(msg.path)
      if (pending && pending.notePageProgress) pending.notePageProgress()
      return
    }
    // Multi-source: if a scheduler owns this path, let it distribute chunk
    // requests across peers instead of the legacy single-peer auto-flow.
    const sched = this._schedulers.get(msg.path)
    if (sched) { Promise.resolve(sched.onChunkHashes(peer, chunks)).catch(() => {}); return }
    // [mirall] the legacy single-peer receive below writes incoming bytes
    // to _filePaths.get(path) and finalizes a rename OVER it. For a path that
    // maps to one of OUR own files (e.g. /mir/<hash>), an unsolicited chunkHashes
    // would let a peer overwrite the owner's source file. Mirall only ever
    // receives via a scheduler (the branch above), so refuse any other receive.
    if (this._serveAuthorizer) return

    const diskPath = this._filePaths.get(msg.path)
    if (!diskPath) return

    // Empty-file fast path: a 0-byte file has no chunks to fetch, but we
    // still need to materialize it on disk and fire the same completion
    // flow as _onChunkData's "transfer complete" branch — otherwise the
    // requester (e.g. NetworkFetcher.getContent) never resolves and times
    // out. Empty files are common in practice: .keep, __init__.py, build
    // stamps, touch'd markers. Bug symptom before this: node-gyp's
    // postinstall.stamp (0 bytes, hash 5187b7a8…) hung every install.
    if (chunks.length === 0) {
      try {
        fs.mkdirSync(path.dirname(diskPath), { recursive: true })
        fs.writeFileSync(diskPath, Buffer.alloc(0))
      } catch {
        return
      }
      const contentHash = hashChunk(Buffer.alloc(0))
      const stat = fs.statSync(diskPath)
      await this._syncEngine._fileIndex.putFile(msg.path, {
        contentHash, size: 0, mtime: stat.mtimeMs
      })
      await this._syncEngine.logPut(msg.path, {
        contentHash, size: 0, mtime: stat.mtimeMs
      })
      if (peer.remoteFeedKey) {
        await this._syncEngine.markSynced(peer.remoteFeedKey, msg.path, contentHash, this._syncEngine.feed.length - 1)
      }
      peer.msgs.transferComplete.send({ path: msg.path, contentHash })
      if (this._syncedCb) {
        this._syncedCb({ path: msg.path, contentHash, size: 0, direction: 'pull' })
      }
      return
    }

    const needed = this._transferManager.computeNeeded(chunks, new Set())
    if (needed.length === 0) return

    let size = 0
    for (const c of chunks) size += c.length

    // [mirall] startReceive can throw (fd open, partial recovery) — drop this
    // transfer instead of rejecting protomux's onmessage promise, which would
    // destroy the whole Noise stream.
    try {
      await this._transferManager.startReceive(diskPath, {
        size,
        chunks: chunks.map((c, i) => {
          let offset = 0
          for (let j = 0; j < i; j++) offset += chunks[j].length
          return { hash: c.hash, offset, length: c.length }
        })
      })
    } catch {
      return
    }

    peer.msgs.chunkNeed.send({ path: msg.path, indices: needed })
  }

  // [mirall] Bump on any membership/space mutation (a member removed, an approval revoked, a
  // leave frame applied): it invalidates every cached serve grant without walking them.
  bumpServeEpoch () {
    this._serveEpoch++
  }

  // [mirall] Drop the serve grants matching a predicate — the ACTIVE half of revocation, for
  // when we know exactly what to stop serving (a space we just left). Takes effect mid-stream:
  // _onChunkNeed re-checks the grant at every drain boundary, so an in-flight multi-chunk send
  // halts at the next one. Returns how many grants were dropped.
  revokeServes (predicate) {
    let revoked = 0
    for (const peer of this._peers.values()) {
      for (const [synthPath, grant] of [...peer.authorizedServe]) {
        let match = false
        try { match = predicate({ contentHash: contentHashOf(synthPath), from: grant.from, peer }) } catch { match = false }
        if (!match) continue
        this._revokeGrant(peer, synthPath, grant)
        revoked++
      }
    }
    return revoked
  }

  // [mirall] Drop one cached serve grant and tell the sender-side indicator the serve ended.
  _revokeGrant (peer, synthPath, grant) {
    peer.authorizedServe.delete(synthPath)
    if (this._serveEndCb) { try { this._serveEndCb({ path: synthPath, peer, from: grant?.from ?? null }) } catch {} }
  }

  // [mirall] The grant still stands iff it was authorized in the current epoch, or re-authorizes
  // now. A stale grant that the gate DEFINITIVELY denies is dropped, so a peer whose membership was
  // revoked mid-transfer stops receiving bytes instead of being served to completion.
  async _serveStillAuthorized (peer, synthPath) {
    const grant = peer.authorizedServe.get(synthPath)
    if (!grant) return false
    if (grant.epoch === this._serveEpoch) return true
    const epoch = this._serveEpoch
    let ok
    // rateLimit:false — this is our own re-validation, not an inbound request from the peer. A
    // THROW is a transient I/O failure (e.g. a space-bee read hiccup under the post-leave re-auth
    // burst), NOT a deny — the peer already passed the gate once, so keep serving and re-check on
    // the next chunk rather than revoking a healthy transfer for a storage blip.
    try { ok = await this._serveAuthorizer(peer, grant.from, contentHashOf(synthPath), { rateLimit: false }) } catch { return true }
    // The grant can be revoked (or the peer torn down) across that await — re-read before trusting.
    const current = peer.authorizedServe.get(synthPath)
    if (current !== grant) return false
    if (!ok) { this._revokeGrant(peer, synthPath, grant); return false }
    grant.epoch = epoch
    return true
  }

  // [mirall] This peer's handle on the shared upload cap, created on first serve. Per PEER,
  // not per limiter: the limiter splits the cap fairly between its streams, so one handle
  // shared by every serve loop would make them race each other instead.
  _uploadStreamFor (peer) {
    if (!this._uploadLimiter || !peer) return null
    if (!peer.uploadStream) peer.uploadStream = this._uploadLimiter.stream()
    return peer.uploadStream
  }

  async _onChunkNeed (peer, msg) {
    // [mirall] serve bytes ONLY for a synthetic path THIS peer was
    // authorized for via a gated _onContentRequest. Blocks a peer pulling bytes
    // by sending chunkNeed directly for a registered path (e.g. /mir/<hash>)
    // without passing the membership serve gate.
    if (this._serveAuthorizer && !(await this._serveStillAuthorized(peer, msg.path))) return
    const diskPath = this._filePaths.get(msg.path)
    if (!diskPath) return

    const fileIndex = this._transferManager._fileIndex
    const chunkMap = msg.path.startsWith('content:')
      ? await fileIndex.getChunkMapByHash(msg.path.slice('content:'.length))
      : await fileIndex.getChunkMap(msg.path)
    if (!chunkMap) return

    for (let i = 0; i < msg.indices.length; i++) {
      const index = msg.indices[i]
      if (index >= chunkMap.length) continue
      const c = chunkMap[index]
      const data = this._transferManager.readChunk(diskPath, c.offset, c.length)
      if (!data) continue
      // [mirall] Upload cap, charged against THIS peer's own stream so concurrent serve
      // loops share the cap by bytes instead of racing (see bandwidth-limiter). take()
      // resolves with the bytes actually paid for; 0 means the wait was aborted — the
      // limiter was destroyed or the peer's handle detached on channel close — and sending
      // anyway would put unmetered bytes on the wire. The wait also opens a revocation
      // window exactly like the drain boundary below, so re-check the grant after it.
      const uploadStream = this._uploadStreamFor(peer)
      if (uploadStream && !uploadStream.isUnlimited()) {
        const paid = await uploadStream.take(data.length)
        if (paid <= 0) return
        if (peer.channel?.closed) return
        if (this._serveAuthorizer && !(await this._serveStillAuthorized(peer, msg.path))) return
      }
      const flushed = peer.msgs.chunkData.send({ path: msg.path, index, data })
      if (this._chunkServeCb) {
        try { this._chunkServeCb({ path: msg.path, index, bytes: data.length, peer, from: peer.authorizedServe.get(msg.path)?.from ?? null }) } catch {}
      }
      // [mirall] §HOL — chunkData, mirall/handshake, and the Corestore replication
      // carrying a peer's freshly shared folder all multiplex over ONE Noise stream
      // (protomux MAX_BACKLOG is Infinity). send() returns the stream's writable state;
      // on backpressure, stop producing content and let the queue (and the share
      // record) drain, else a peer mid-download never sees a new share until it pauses.
      if (flushed === false && i < msg.indices.length - 1) {
        const alive = await this._waitForDrain(peer)
        if (!alive) return
        // [mirall] Re-check the grant at the drain boundary: a revocation (space left, member
        // removed) that lands mid-send stops the remaining chunks here.
        if (this._serveAuthorizer && !(await this._serveStillAuthorized(peer, msg.path))) return
      }
    }
  }

  // [mirall] §HOL — one shared drain waiter per peer so concurrent serve loops (the
  // same peer pulling several files) don't each attach listeners and trip the stream's
  // max-listeners warning. Resolves true on drain, false if the channel closes first.
  _waitForDrain (peer) {
    const channel = peer.channel
    const stream = peer.mux && peer.mux.stream
    if (!stream || !channel || channel.closed) return Promise.resolve(false)
    if (channel.drained) return Promise.resolve(true)
    if (peer._drainWait) return peer._drainWait
    peer._drainWait = new Promise((resolve) => {
      let timer = null
      const done = (alive) => {
        if (timer) clearTimeout(timer)
        stream.removeListener('drain', onDrain)
        stream.removeListener('close', onClose)
        peer._drainWait = null
        resolve(alive)
      }
      const onDrain = () => done(!channel.closed)
      const onClose = () => done(false)
      timer = setTimeout(() => done(false), DRAIN_TIMEOUT_MS)
      stream.on('drain', onDrain)
      stream.on('close', onClose)
    })
    return peer._drainWait
  }

  async _onChunkData (peer, msg) {
    // Silent-peer watchdog hook: fire BEFORE any processing so a slow disk
    // doesn't get blamed for a peer-side stall.
    if (this._chunkProgressCb) {
      try {
        this._chunkProgressCb({
          path: msg.path,
          index: msg.index,
          bytes: msg.data ? msg.data.length : 0,
          peer
        })
      } catch {}
    }

    // Multi-source: scheduler owns the write + reschedule + finalize.
    const sched = this._schedulers.get(msg.path)
    if (sched) { Promise.resolve(sched.onChunkData(peer, msg.index, msg.data)).catch(() => {}); return }
    // [mirall] refuse the legacy single-peer receive (writes+renames over
    // _filePaths.get(path), i.e. potentially our own source file). Mirall only
    // receives via a scheduler (above).
    if (this._serveAuthorizer) return

    const diskPath = this._filePaths.get(msg.path)
    if (!diskPath) return

    const result = this._transferManager.writeChunk(diskPath, msg.index, msg.data)

    if (result.ok && this._transferManager.isComplete(diskPath)) {
      const fin = await this._transferManager.finalize(diskPath)
      if (fin.ok) {
        const fileData = fs.readFileSync(diskPath)
        const contentHash = hashChunk(fileData)
        const stat = fs.statSync(diskPath)

        await this._syncEngine._fileIndex.putFile(msg.path, {
          contentHash, size: stat.size, mtime: stat.mtimeMs
        })
        await this._syncEngine.logPut(msg.path, {
          contentHash, size: stat.size, mtime: stat.mtimeMs
        })

        if (peer.remoteFeedKey) {
          await this._syncEngine.markSynced(peer.remoteFeedKey, msg.path, contentHash, this._syncEngine.feed.length - 1)
        }

        peer.msgs.transferComplete.send({ path: msg.path, contentHash })
        if (this._syncedCb) {
          this._syncedCb({ path: msg.path, contentHash, size: stat.size, direction: 'pull' })
        }
      }
    }
  }

  _onChunkCancel (peer, msg) {
    const diskPath = this._filePaths.get(msg.path)
    if (diskPath) this._transferManager.cancel(diskPath)
  }

  // Resolve a serve-message's downloader identity from the authenticated record we kept at
  // serve start (peer.authorizedServe), NOT the message — so a peer can only affect its own
  // ledger row, never spoof another. Returns null `from` when the peer was never authorized.
  _authorizedFrom (peer, contentHash) {
    const synthPath = 'content:' + contentHash
    return { synthPath, from: peer.authorizedServe.get(synthPath)?.from ?? null }
  }

  // A downloader told us it paused/stopped pulling a hash WE serve.
  _onTransferControl (peer, msg) {
    if (!this._serveControlCb) return
    const { synthPath, from } = this._authorizedFrom(peer, msg.contentHash)
    if (!from) return
    const state = msg.state === CONTROL_STOPPED ? 'stopped' : 'paused'
    try { this._serveControlCb({ path: synthPath, peer, from, state }) } catch {}
  }

  // A downloader reported its on-disk have-bytes for a hash WE serve.
  _onTransferProgress (peer, msg) {
    if (!this._serveProgressCb) return
    const { synthPath, from } = this._authorizedFrom(peer, msg.contentHash)
    if (!from) return
    try { this._serveProgressCb({ path: synthPath, peer, from, have: msg.have || 0 }) } catch {}
  }

  async _onTransferComplete (peer, msg) {
    if (peer.remoteFeedKey) {
      await this._syncEngine.markSynced(peer.remoteFeedKey, msg.path, msg.contentHash, this._syncEngine.feed.length - 1)
    }
    if (this._syncedCb) {
      this._syncedCb({ path: msg.path, contentHash: msg.contentHash, direction: 'push' })
    }
  }

  _onConflictMsg (peer, msg) {
    if (this._conflictCb) this._conflictCb(msg, peer)
  }

  // ── Tree handlers (0.5a) ────────────────────────────────────

  async _onTreeRequest (peer, msg) {
    // [mirall] ungated metadata oracle (returns fileIndex tree entries to
    // any peer). Mirall overlay never uses tree-requests; refuse in mirall mode.
    if (this._serveAuthorizer) return
    let entries = []
    try {
      const fileIndex = this._syncEngine && this._syncEngine._fileIndex
      if (fileIndex && typeof fileIndex.getTree === 'function') {
        const tree = await fileIndex.getTree(msg.hash)
        if (tree && Array.isArray(tree.entries)) entries = tree.entries
      }
    } catch {
      // fall through — reply with empty entries on lookup failure
    }
    this._sendTreeResponse(peer, msg.hash, entries, msg.nonce || 0)
  }

  _onTreeResponse (peer, msg) {
    const pending = peer.pendingTrees.get(msg.hash)
    if (!pending) return // no request in flight — drop
    // [mirall] §4.15 — drop a page echoing a superseded request's nonce (a stale page from
    // a timed-out attempt must not settle a later same-hash retry). nonce 0 = a pre-nonce
    // holder that can't echo it, so fall through (unverifiable, best-effort).
    if (msg.nonce && msg.nonce !== pending.nonce) return
    const settle = (fn, arg) => { clearTimeout(pending.timer); peer.pendingTrees.delete(msg.hash); fn(arg) }
    // Lone complete frame (the small-tree norm) resolves with no accumulation.
    if (!pending.pages && !msg.more) return settle(pending.resolve, msg.entries)
    // Accumulate into THIS request's own buffer, bounding total bytes so a peer streaming
    // pages endlessly rejects the request instead of growing memory without limit.
    if (!pending.pages) pending.pages = []
    for (const e of msg.entries) { pending.pages.push(e); pending.pageBytes += this._treeEntryWireSize(e) }
    if (pending.pageBytes > this._maxTreeResponseBytes) {
      return settle(pending.reject, new Error('tree response too large: ' + msg.hash))
    }
    if (msg.more) {
      // Forward progress — re-arm the idle timeout so a legitimately large multi-page
      // tree on a slow link doesn't time out mid-stream.
      clearTimeout(pending.timer)
      this._armTreeTimeout(peer, msg.hash, pending)
      return
    }
    settle(pending.resolve, pending.pages)
  }

  async _onContentRequest (peer, msg) {
    // [mirall] Capture the epoch BEFORE the async authorize: if a membership change bumps it during
    // the await, the grant below is stamped with the OLD epoch, so _serveStillAuthorized re-checks
    // it on the next chunk instead of trusting a decision the bump was meant to invalidate.
    const authEpoch = this._serveEpoch
    // [mirall] serve gate. BEFORE any path resolution or streaming,
    // ask the injected authorizer whether this peer may receive this hash.
    // Deny == silent return (same observable behavior as "I don't hold it"
    // below), so a non-member cannot distinguish denial from absence.
    if (this._serveAuthorizer) {
      let ok = false
      try { ok = await this._serveAuthorizer(peer, msg.from || null, msg.contentHash) } catch { ok = false }
      if (!ok) return
    }

    // Resolve msg.contentHash → an on-disk path. Three lookup paths, in order:
    //  1. Fast path: _contentHashPaths map (warm — just-registered / consumer-set)
    //  2. Content-addressed spool (RESTART-DURABLE): <syncBaseDir>/<contentHash>
    //  3. Slow path: scan fileIndex for any file:* entry with that hash
    let diskPath = this._contentHashPaths.get(msg.contentHash)
    if (diskPath && !fileExists(diskPath)) diskPath = null

    if (!diskPath) {
      // Content-addressed spool fallback. The canonical bytes are stored at
      // <syncBaseDir>/<contentHash> (pear-git-v3 spools an upload to spool/<oid>
      // where oid IS the content hash — router.js). The in-memory map is empty
      // after a daemon restart and FileIndex persists no disk path, so resolve
      // the hash straight from the content-addressed spool — a pure function of
      // the hash + dir, like the tree-store's blobs/<hash>. This is what lets a
      // forge keep serving its large files (hyper-tps LFS) across restarts.
      // (NOT gip bundles: those are stored by git oid, not by contentHash — they
      // need autobase-driven rehydration, tracked separately.)
      for (const baseDir of this._syncBaseDirs) {
        const candidate = path.join(baseDir, msg.contentHash)
        if (fileExists(candidate)) {
          diskPath = candidate
          this._contentHashPaths.set(msg.contentHash, candidate) // warm the map
          break
        }
      }
    }

    if (!diskPath) {
      // Scan fileIndex for a file whose contentHash matches.
      const fileIndex = this._syncEngine && this._syncEngine._fileIndex
      if (fileIndex && typeof fileIndex.listFiles === 'function') {
        try {
          const files = await fileIndex.listFiles()
          for (const f of files) {
            if (f.contentHash === msg.contentHash) {
              diskPath = this._filePaths.get(f.path)
              if ((!diskPath || !fileExists(diskPath)) && f.path) diskPath = f.path
              break
            }
          }
        } catch {
          // fall through
        }
      }
    }

    if (!diskPath) {
      // Don't have it. Silently drop; requester will time out.
      return
    }

    // Use a SYNTHETIC path keyed by contentHash so the requester can
    // pre-register a destPath and the chunk flow routes correctly on
    // both sides. Temporarily populate _filePaths so _onChunkNeed +
    // chunkmap lookups resolve under this synthetic key.
    const syntheticPath = 'content:' + msg.contentHash
    this._filePaths.set(syntheticPath, diskPath)
    peer.authorizedServe.set(syntheticPath, { from: msg.from || null, epoch: authEpoch }) // [mirall] _onChunkNeed will now serve this path to THIS peer, until the epoch moves past authEpoch

    // [mirall] The chunk map is content-addressed — identical bytes always chunk
    // identically. Reuse one computed at publish (or a prior serve, or before a
    // restart) instead of re-reading the whole file to re-chunk it: re-chunking a
    // multi-GB file adds a full-file-read of latency before the first byte ships.
    const fileIndex = this._transferManager._fileIndex
    let chunks = await fileIndex.getChunkMapByHash(msg.contentHash)
    let tier
    if (chunks) {
      let size = 0
      try { size = fs.statSync(diskPath).size } catch {}
      tier = selectTier(size)
    } else {
      const prepared = await this._transferManager.prepareFile(diskPath, syntheticPath, { byHashOnly: true })
      if (!prepared) {
        this._filePaths.delete(syntheticPath)
        peer.authorizedServe.delete(syntheticPath) // [mirall] keep the authorize map in lockstep with _filePaths
        return
      }
      chunks = prepared.chunks
      tier = prepared.tier
      // prepareFile persists the hash-keyed map only for large files; ensure it exists
      // for small ones too, since _onChunkNeed resolves content:<hash> by that map.
      if (!await fileIndex.hasChunkMapByHash(msg.contentHash)) await fileIndex.putChunkMapByHash(msg.contentHash, chunks)
    }
    this._sendChunkHashes(peer, syntheticPath, tier, chunks)
    if (this._serveStartCb) {
      let total = 0
      for (const c of chunks) total += c.length || 0
      try { this._serveStartCb({ path: syntheticPath, peer, from: msg.from || null, total }) } catch {}
    }
  }

  // ── Sync logic ──────────────────────────────────────────────

  /**
   * Offer all local files to a peer.
   * Reads from the local feed and sends file-offers for each entry.
   * The peer will request any files it doesn't have.
   */
  async _offerLocalFiles (peer) {
    const feed = this._syncEngine.feed
    if (feed.length === 0) return

    for (let i = 0; i < feed.length; i++) {
      try {
        const entry = await feed.get(i)
        if (!entry) continue

        // Register the file path mapping so _onFileRequest can find it
        if (entry.op === 0) {
          const diskPath = this._resolveFilePath(entry.path)
          if (diskPath) this._filePaths.set(entry.path, diskPath)
        }

        peer.msgs.fileOffer.send({
          path: entry.path,
          contentHash: entry.hash || '0'.repeat(64),
          size: entry.size || 0,
          mtime: entry.mtime || 0,
          op: entry.op
        })
      } catch {
        // skip unreadable entries
      }
    }
  }

  /**
   * Resolve an overlay path to a disk path.
   */
  _resolveFilePath (overlayPath) {
    if (this._filePaths.has(overlayPath)) return this._filePaths.get(overlayPath)
    for (const baseDir of this._syncBaseDirs) {
      return path.join(baseDir, overlayPath)
    }
    return null
  }
}

// True iff `p` is an existing regular file. Used to validate a resolved disk path
// before serving (a cold-restart map entry or an overlay-path masquerading as a
// disk path won't exist) and to probe the content-addressed spool.
function fileExists (p) {
  try { return fs.statSync(p).isFile() } catch { return false }
}

// [mirall] The content hash a serve grant is keyed by. Grants live under the synthetic
// 'content:<hash>' path; anything else is a plain registered path and carries no hash.
function contentHashOf (synthPath) {
  return synthPath.startsWith('content:') ? synthPath.slice('content:'.length) : null
}
