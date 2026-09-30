// SPDX-License-Identifier: AGPL-3.0-only
// Derived from hyper-overlay lib/overlay-v2.js @ 6cac8ee (v0.2.9), Copyright (C) 2026 the
// hyper-overlay authors, licensed AGPL-3.0. Modified for Mirall in 2026; PROVENANCE.md
// lists the changes and carries the full license notice.

// HyperOverlayV2 — content-addressed file serving over the V2 protocol: a facade over FileIndex,
// TransferManager and OverlayProtocolV2. The canonical bytes are a REAL FILE ON DISK; the index holds
// only chunk maps. registerFile makes a file servable by its content hash, and fetchFile pulls a
// hash from every connected holder in parallel, verifying chunks and the whole-file hash as they
// land. Every serve passes the injected serveAuthorizer.

import ReadyResource from 'ready-resource'
import fs from 'bare-fs'

import { FileIndex, indexCoreName } from './file-index.js'
import { TransferManager } from './transfer.js'
import { OverlayProtocolV2 } from './protocol-v2.js'
import { createStreamingHasher } from './chunker.js'

// [mirall] Stream-verify a file against its overlay content hash WITHOUT buffering
// it — a readFileSync of a multi-GB blob OOMs the worker. Matches
// crypto.data(buffer): blake2b(LEAF_TYPE || uint64-LE(size) || bytes), which is
// exactly createStreamingHasher({ size }). Returns the size so a local hit needs no
// second stat.
async function verifyOnDisk (filePath, contentHash) {
  let size
  try { size = fs.statSync(filePath).size } catch { return { ok: false, size: 0 } }
  const h = createStreamingHasher({ size })
  try {
    await new Promise((resolve, reject) => {
      const rs = fs.createReadStream(filePath)
      rs.on('data', (c) => h.update(c))
      rs.on('end', resolve)
      rs.on('error', reject)
    })
  } catch { return { ok: false, size } }
  return { ok: h.digest() === contentHash, size }
}

export class HyperOverlayV2 extends ReadyResource {
  constructor (corestore, opts = {}) {
    super()
    if (typeof opts.serveAuthorizer !== 'function') throw new TypeError('serveAuthorizer is required')
    this._corestore = corestore.namespace(opts.namespace || 'overlay-v2')
    this._journalDir = opts.journalDir || null
    this._partialSuffix = opts.partialSuffix || null // [mirall] §4.17

    // [mirall] Serve-authorization + identity opts threaded to OverlayProtocolV2.
    // serveAuthorizer gates every inbound content-request; localProfileKey stamps
    // outbound content-requests so the remote's gate can authenticate the asker.
    this._serveAuthorizer = opts.serveAuthorizer
    // [mirall] §4.24 — the fetch gate, serveAuthorizer's download-side twin:
    // holderAuthorizer(peer, ownerKey) → boolean picks which attached peers a fetchFile
    // sends its content request to. Absent → every attached peer (upstream).
    this._holderAuthorizer = opts.holderAuthorizer || null
    this._localProfileKey = opts.localProfileKey || null
    // [mirall] channel handshake policy, threaded to OverlayProtocolV2 unchanged.
    this._minVersion = opts.minVersion
    this._onPeerOpen = opts.onPeerOpen || null
    this._onPeerRejected = opts.onPeerRejected || null

    // [mirall] At-rest key for the local index cores (file-index, index-meta).
    this._indexEncryptionKey = opts.indexEncryptionKey || null

    // [mirall] serve-side download telemetry (sender-side download indicator).
    this._onServeStart = opts.onServeStart || null
    this._onChunkServe = opts.onChunkServe || null
    this._onServeEnd = opts.onServeEnd || null
    this._onServeControl = opts.onServeControl || null
    this._onServeProgress = opts.onServeProgress || null

    // [mirall] content-plane transfer caps, injected by the app layer.
    this._uploadLimiter = opts.uploadLimiter || null
    this._downloadLimiter = opts.downloadLimiter || null
    // [mirall] decoded chunk-map cache, injected by the app layer like the limiters.
    this._chunkMapCache = opts.chunkMapCache || null
    // [mirall] serve-fd idle window, threaded to the protocol (tests shrink it).
    this._serveFdIdleMs = opts.serveFdIdleMs

    // Shared with the protocol: _filePaths maps a granted `content:<hash>` serve path to its disk
    // path; _contentHashPaths maps a hash to the file that serves it (registerFile).
    this._filePaths = new Map()
    this._contentHashPaths = new Map()

    this._index = null
    this._transfer = null
    this._protocol = null
    this._stackPromise = null
  }

  // The protocol must exist synchronously when attachProtocol is called —
  // protomux will NOT pair a channel created after the remote opened theirs
  // (verified). So the stack is built at ready time. _ensure stays as the
  // idempotent builder (used by register/fetch, and as a safety net).
  async _open () { await this._ensure() }

  // [mirall] Destroy the protocol without the index, so the host can fire the
  // peer teardown (and its serve-end callbacks) while the sockets are still up and keep serving
  // from the index afterwards. Idempotent; _close below is a no-op for the protocol once run.
  closeProtocol () {
    if (this._protocol) {
      this._protocol.destroy()
      this._protocol = null
    }
  }

  async _close () {
    // Only tear down what was actually built.
    if (this._protocol) this._protocol.destroy()
    if (this._index) await this._index.close()
  }

  // Lazily build the V2 stack. Idempotent + concurrency-safe (a single
  // in-flight promise is shared). No-op cost once built.
  _ensure () {
    if (this._protocol) return Promise.resolve()
    if (this._stackPromise) return this._stackPromise
    this._stackPromise = (async () => {
      const index = new FileIndex(this._corestore, { encryptionKey: this._indexEncryptionKey, chunkMapCache: this._chunkMapCache })
      await index.ready()
      const transfer = new TransferManager(index, { journalDir: this._journalDir, partialSuffix: this._partialSuffix })
      const protocol = new OverlayProtocolV2(transfer, {
        filePaths: this._filePaths,
        contentHashPaths: this._contentHashPaths,
        serveAuthorizer: this._serveAuthorizer,   // [mirall] serve gate
        localProfileKey: this._localProfileKey,    // [mirall] outbound identity
        minVersion: this._minVersion,              // [mirall] undefined -> protocol default
        onPeerOpen: this._onPeerOpen,
        onPeerRejected: this._onPeerRejected,
        onServeStart: this._onServeStart,
        onChunkServe: this._onChunkServe,
        onServeEnd: this._onServeEnd,
        onServeControl: this._onServeControl,
        onServeProgress: this._onServeProgress,
        uploadLimiter: this._uploadLimiter,
        downloadLimiter: this._downloadLimiter,
        serveFdIdleMs: this._serveFdIdleMs
      })
      if (this._journalDir) { try { fs.mkdirSync(this._journalDir, { recursive: true }) } catch {} }
      this._index = index
      this._transfer = transfer
      this._protocol = protocol
    })()
    return this._stackPromise
  }

  // hyper-svc's swarm transport calls this synchronously per connection. The
  // channel MUST be created synchronously — protomux will not pair a channel
  // opened after the remote's (verified). The stack is built at ready, so
  // this._protocol is always present by the time connections arrive.
  attachProtocol (mux) {
    if (this.closing || this.closed || !this._protocol) return
    return this._protocol.attach(mux)
  }

  get peerCount () { return this._protocol ? this._protocol.peerCount : 0 }

  // The overlay's local-only cores (file-index + version marker), so the leftover scan can treat
  // them as wanted and the storage breakdown can size them.
  localCores () { return this._index ? this._index.cores : [] }

  cleanJournals (maxAge) { try { return this._transfer?.cleanJournals(maxAge) || [] } catch { return [] } }

  // Make an on-disk file servable by its content hash. The chunk map is built lazily, on the first
  // peer request, or eagerly by prepareForServe. Returns null when the source vanished.
  async registerFile (diskPath, meta = {}) {
    await this._ensure()
    let stat
    try { stat = fs.statSync(diskPath) } catch { return null }
    const size = typeof meta.size === 'number' ? meta.size : stat.size
    const contentHash = meta.contentHash || await hashFileOnDisk(diskPath, size)
    this._contentHashPaths.set(contentHash, diskPath)
    return { contentHash, size }
  }

  // [mirall] One-pass hash + chunk-map build for the publish path: streams the file
  // ONCE, persists the content-addressed chunk map (durable in FileIndex), and
  // returns the content hash. Replaces a hash-only pass plus a lazy fetch-time
  // re-chunk with a single read, so the first fetcher never waits on chunk indexing.
  async prepareForServe (diskPath, opts = {}) {
    await this._ensure()
    const prepared = await this._transfer.prepareFile(diskPath, { onProgress: opts.onProgress, signal: opts.signal })
    return prepared ? { contentHash: prepared.contentHash, size: prepared.size } : null
  }

  // The content: serve entry and _contentHashPaths stay: a download in flight still reads the
  // first, the readers of the second re-check the disk, and dropping either races a same-hash
  // re-registration.
  async evictContent (contentHash) {
    await this._ensure()
    return this._index.evictContent(contentHash)
  }

  // [mirall] §4.23 — the retired generation's alias rides along with its core, so the caller
  // that clears and purges the core can drop the by-name alias in the same pass.
  async compactIndex (opts) {
    await this._ensure()
    const retired = { name: indexCoreName(this._index.version), namespace: this._corestore.ns }
    const core = await this._index.compact(opts)
    return core ? { core, alias: retired } : null
  }

  /**
   * Fetch a file by its content hash. Serves from the local disk copy if we
   * have it; otherwise pulls from a connected peer that does (hash-verified).
   * @param {string} contentHash
   * @param {object} [opts] opts.timeout (idle), opts.destPath (required for a remote fetch), [mirall] §4.24 opts.ownerKey
   *   (handed to holderAuthorizer) and opts.size (the size the chunk map must describe),
   *   [mirall] §4.25 opts.parentMustExist (the receive never creates destPath's folder)
   * @returns {Promise<{ destPath: string, local: boolean, size: number } | null>}
   */
  async fetchFile (contentHash, opts = {}) {
    await this._ensure()

    const localDisk = this._contentHashPaths.get(contentHash)
    if (localDisk) {
      const v = await verifyOnDisk(localDisk, contentHash)
      if (v.ok) return { destPath: localDisk, local: true, size: v.size }
    }

    // Wait briefly for at least one peer — a connection may be mid-handshake
    // (lazy attach) or just forming when the fetch is issued. Without this a
    // fetch issued the instant a peer connects would spuriously 404.
    const peerWaitMs = opts.peerWaitMs || 3000
    for (let waited = 0; this._fetchPeers(opts.ownerKey).length === 0 && waited < peerWaitMs; waited += 100) {
      await new Promise(r => setTimeout(r, 100))
    }
    // Multi-source: fetch chunks in parallel from ALL connected peers that
    // have the file (torrent-style). The scheduler dedups + fails over.
    const peers = this._fetchPeers(opts.ownerKey)   // [mirall] §4.24
    if (peers.length === 0) {
      // No fetchContent will run, so drop any cancel recorded during the wait — a
      // stale marker would otherwise cancel the next fetch of the same content. [mirall]
      this._protocol.clearCancelPending(contentHash)
      return null
    }

    if (!opts.destPath) {
      this._protocol.clearCancelPending(contentHash)
      throw new TypeError('fetchFile: destPath is required for a remote fetch')
    }
    const destPath = opts.destPath
    // Whole-file integrity is verified INCREMENTALLY during the transfer (the
    // scheduler passes contentHash to TransferManager, which hashes the file in
    // offset order as chunks land and rejects in finalize on a mismatch). So the
    // assembled file is already verified here — no trailing whole-file re-read.
    let result
    try {
      result = await this._protocol.fetchContent(contentHash, peers, {
        destPath,
        size: opts.size,                              // [mirall] §4.24 — the geometry the map must match
        parentMustExist: opts.parentMustExist,        // [mirall] §4.25
        timeout: opts.timeout,
        onProgress: opts.onProgress || (() => {}),   // [mirall] forward bytes/total
        onVerify: opts.onVerify,                      // [mirall] resume re-verify fraction
        onEnd: opts.onEnd                             // [mirall] terminal diagnostic (reason + bytes/chunks)
      })
    } catch (err) {
      // An integrity failure or an explicit cancel/pause is distinct from a
      // no-holder / stall — surface it so the caller doesn't treat it as a failure.
      if (err?.code === 'EHASHMISMATCH' || err?.code === 'ECANCELLED') throw err
      // [mirall] A local I/O error (full disk / read-only / permission / vanished
      // mount) is not a no-holder — surface it so the consumer can pause rather than
      // retry forever.
      if (err?.code === 'ENOSPC' || err?.code === 'EACCES' || err?.code === 'EROFS' || err?.code === 'EPERM' || err?.code === 'ENOENT') throw err
      return null
    }
    const size = result?.size ?? fs.statSync(destPath).size
    return { destPath, local: false, size }
  }

  // [mirall] §4.24 — the peers a fetch may ask. A throwing authorizer denies, like serveAuthorizer.
  _fetchPeers (ownerKey) {
    const peers = [...this._protocol._peers.values()]
    if (!this._holderAuthorizer) return peers
    return peers.filter((peer) => {
      try { return this._holderAuthorizer(peer, ownerKey ?? null) === true } catch { return false }
    })
  }

  // [mirall] Stop an in-flight fetchFile for this content hash. opts.discardPartial
  // true unlinks the partial (cancel), false keeps it for resume (pause). The
  // pending fetchFile rejects with ECANCELLED, which the caller treats as not-a-failure.
  cancelFetch (contentHash, opts = {}) {
    return this._protocol ? this._protocol.cancelContent(contentHash, opts) : false
  }

  // [mirall] Tell holders we stopped pulling this hash when there's no in-flight fetch
  // to tear down (e.g. discarding an already-paused transfer), so their indicator clears.
  notifyTransferStopped (contentHash) {
    return this._protocol ? this._protocol.sendStopControl(contentHash) : false
  }

  // [mirall] Stop serving the grants a predicate selects (a space we left). Returns the count.
  revokeServes (predicate) {
    return this._protocol ? this._protocol.revokeServes(predicate) : 0
  }

  // [mirall] Invalidate every cached serve grant, forcing one re-authorization per (peer, path)
  // on the next chunk request. The membership gate is the source of truth; this is what makes a
  // revocation reach a transfer already in flight.
  bumpServeEpoch () {
    if (this._protocol) this._protocol.bumpServeEpoch()
  }
}

// Stream a file through the chunker's hasher to get its oid without buffering
// the whole file in memory (matches /api/upload's createStreamingHasher oid).
async function hashFileOnDisk (diskPath, size) {
  const hasher = createStreamingHasher({ size })
  for await (const buf of fs.createReadStream(diskPath)) hasher.update(buf)
  return hasher.digest()
}
