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

import { FileIndex, indexCoreName } from './store/file-index.js'
import { TransferManager } from './transfer/transfer-manager.js'
import { OverlayProtocolV2 } from './protocol/protocol.js'
import { createStreamingHasher } from './chunker.js'
import { surfacesToCaller } from './local-faults.js'

// How long a fetch waits for a holder to attach: a connection may be mid-handshake when the fetch
// is issued, and without the wait it would read as "no holder".
const HOLDER_WAIT_MS = 3000
const HOLDER_POLL_MS = 100

// Stream-verify a file against its content hash without buffering it (a readFileSync of a multi-GB
// file OOMs the worker). createStreamingHasher({ size }) matches crypto.data(buffer).
async function verifyOnDisk(filePath, contentHash) {
  let size
  try { size = fs.statSync(filePath).size } catch { return { ok: false, size: 0 } }
  const h = createStreamingHasher({ size })
  try {
    await new Promise((resolve, reject) => {
      const rs = fs.createReadStream(filePath)
      rs.on('data', (c) => h.update(c))
      rs.on('end', () => resolve())
      rs.on('error', reject)
    })
  } catch { return { ok: false, size } }
  return { ok: h.digest() === contentHash, size }
}

export class HyperOverlayV2 extends ReadyResource {
  // opts: serveAuthorizer (required) gates every inbound request; holderAuthorizer(peer, ownerKey)
  // picks which attached peers a fetch asks (absent: every one); localProfileKey is stamped on
  // outbound requests; indexEncryptionKey encrypts the local cores; the limiters, chunkMapCache,
  // serve callbacks and handshake policy are injected by the host and passed through.
  constructor(corestore, opts = {}) {
    super()
    if (typeof opts.serveAuthorizer !== 'function') throw new TypeError('serveAuthorizer is required')
    this._corestore = corestore.namespace(opts.namespace || 'overlay-v2')
    this._opts = opts
    this._holderAuthorizer = opts.holderAuthorizer || null
    // contentHash → the file that serves it (registerFile).
    this._contentHashPaths = new Map()
    this._index = null
    this._transfer = null
    this._protocol = null
    this._stackPromise = null
  }

  /** @internal */
  get index() { return this._index }

  /** @internal */
  get transfer() { return this._transfer }

  /** @internal */
  get protocol() { return this._protocol }

  // The protocol must exist synchronously when attachProtocol runs: protomux does not pair a
  // channel created after the remote opened theirs. So the stack is built at ready.
  async _open() { await this._ensure() }

  // Destroy the protocol but keep the index, so the host can fire the peer teardown (and its
  // serve-end callbacks) while the sockets are still up. Idempotent.
  closeProtocol() {
    if (!this._protocol) return
    this._protocol.destroy()
    this._protocol = null
  }

  async _close() {
    if (this._protocol) this._protocol.destroy()
    if (this._index) await this._index.close()
  }

  // Build the stack once; concurrent callers share the one in-flight promise.
  _ensure() {
    if (this._protocol) return Promise.resolve()
    if (this._stackPromise) return this._stackPromise
    this._stackPromise = this._build()
    return this._stackPromise
  }

  async _build() {
    const o = this._opts
    const index = new FileIndex(this._corestore, { encryptionKey: o.indexEncryptionKey || null, chunkMapCache: o.chunkMapCache || null })
    await index.ready()
    const transfer = new TransferManager(index, { journalDir: o.journalDir || null, partialSuffix: o.partialSuffix || null })
    const protocol = new OverlayProtocolV2(transfer, {
      fileIndex: index,
      contentHashPaths: this._contentHashPaths,
      serveAuthorizer: o.serveAuthorizer,
      localProfileKey: o.localProfileKey || null,
      minVersion: o.minVersion,
      onPeerOpen: o.onPeerOpen || null,
      onPeerRejected: o.onPeerRejected || null,
      onServeStart: o.onServeStart || null,
      onChunkServe: o.onChunkServe || null,
      onServeEnd: o.onServeEnd || null,
      onServeControl: o.onServeControl || null,
      onServeProgress: o.onServeProgress || null,
      uploadLimiter: o.uploadLimiter || null,
      downloadLimiter: o.downloadLimiter || null,
      serveFdIdleMs: o.serveFdIdleMs,
    })
    this._index = index
    this._transfer = transfer
    this._protocol = protocol
  }

  // The swarm transport calls this synchronously per connection; the stack is built at ready, so
  // the protocol is present by then.
  attachProtocol(mux) {
    if (this.closing || this.closed || !this._protocol) return
    return this._protocol.attach(mux)
  }

  get peerCount() { return this._protocol ? this._protocol.peerCount : 0 }

  // The overlay's local-only cores (file-index and its version marker), so the leftover scan can
  // treat them as wanted and the storage breakdown can size them.
  localCores() { return this._index ? this._index.cores : [] }

  cleanJournals(maxAge) { try { return this._transfer?.cleanJournals(maxAge) || [] } catch { return [] } }

  // Make an on-disk file servable by its content hash. The chunk map is built on the first peer
  // request, or up front by prepareForServe. Returns null when the source vanished.
  async registerFile(diskPath, meta = {}) {
    await this._ensure()
    let stat
    try { stat = fs.statSync(diskPath) } catch { return null }
    const size = typeof meta.size === 'number' ? meta.size : stat.size
    const contentHash = meta.contentHash || await hashFileOnDisk(diskPath, size)
    this._contentHashPaths.set(contentHash, diskPath)
    return { contentHash, size }
  }

  // One pass over the file for the publish path: hash it and persist its chunk map, so the first
  // fetcher never waits on chunking.
  async prepareForServe(diskPath, opts = {}) {
    await this._ensure()
    const prepared = await this._transfer.prepareFile(diskPath, { onProgress: opts.onProgress, signal: opts.signal })
    return prepared ? { contentHash: prepared.contentHash, size: prepared.size } : null
  }

  // The serve entry and _contentHashPaths stay: a download in flight still reads the first, the
  // readers of the second re-check the disk, and dropping either races a same-hash re-registration.
  async evictContent(contentHash) {
    await this._ensure()
    return this._index.evictContent(contentHash)
  }

  // The retired generation's alias rides along with its core, so the caller that clears and purges
  // the core can drop the by-name alias in the same pass.
  async compactIndex(opts) {
    await this._ensure()
    const retired = { name: indexCoreName(this._index.version), namespace: this._corestore.ns }
    const core = await this._index.compact(opts)
    return core ? { core, alias: retired } : null
  }

  // Fetch a file by content hash: from the local copy when it verifies, else from every connected
  // holder in parallel into opts.destPath (required for a remote fetch). opts: ownerKey (handed to
  // holderAuthorizer), size (the size the map must describe), parentMustExist (the receive never
  // creates destPath's folder), timeout (idle), peerWaitMs, onProgress, onVerify, onEnd. Resolves
  // { destPath, local, size }, or null when no holder answered; rejects with every coded local
  // fault (local-faults.js).
  async fetchFile(contentHash, opts = {}) {
    await this._ensure()
    const localDisk = this._contentHashPaths.get(contentHash)
    if (localDisk) {
      const v = await verifyOnDisk(localDisk, contentHash)
      if (v.ok) return { destPath: localDisk, local: true, size: v.size }
    }
    const peers = await this._awaitHolders(opts.ownerKey, opts.peerWaitMs || HOLDER_WAIT_MS)
    // No fetch will run, so a cancel recorded during the wait must not cancel the next one.
    if (peers.length === 0) {
      this._protocol.clearCancelPending(contentHash)
      return null
    }
    if (!opts.destPath) {
      this._protocol.clearCancelPending(contentHash)
      throw new TypeError('fetchFile: destPath is required for a remote fetch')
    }
    let result
    try {
      result = await this._protocol.fetchContent(contentHash, peers, {
        destPath: opts.destPath,
        size: opts.size,
        parentMustExist: opts.parentMustExist,
        timeout: opts.timeout,
        onProgress: opts.onProgress || (() => {}),
        onVerify: opts.onVerify,
        onEnd: opts.onEnd,
      })
    } catch (err) {
      if (surfacesToCaller(err)) throw err
      return null
    }
    return { destPath: opts.destPath, local: false, size: result?.size ?? fs.statSync(opts.destPath).size }
  }

  async _awaitHolders(ownerKey, waitMs) {
    for (let waited = 0; this._fetchPeers(ownerKey).length === 0 && waited < waitMs; waited += HOLDER_POLL_MS) {
      await new Promise((resolve) => setTimeout(resolve, HOLDER_POLL_MS))
    }
    return this._fetchPeers(ownerKey)
  }

  // The peers a fetch may ask. A throwing authorizer denies, like serveAuthorizer.
  _fetchPeers(ownerKey) {
    const peers = [...this._protocol.peers()]
    if (!this._holderAuthorizer) return peers
    return peers.filter((peer) => {
      try { return this._holderAuthorizer(peer, ownerKey ?? null) === true } catch { return false }
    })
  }

  // Stop an in-flight fetch. discardPartial unlinks the partial (cancel); otherwise it is kept for
  // resume (pause). The pending fetchFile rejects with ECANCELLED.
  cancelFetch(contentHash, opts = {}) {
    return this._protocol ? this._protocol.cancelContent(contentHash, opts) : false
  }

  // Tell holders we stopped pulling a hash that has no fetch in flight, so their indicator clears.
  notifyTransferStopped(contentHash) {
    return this._protocol ? this._protocol.sendStopControl(contentHash) : false
  }

  // Stop serving the grants a predicate selects (a space we left). Returns the count.
  revokeServes(predicate) {
    return this._protocol ? this._protocol.revokeServes(predicate) : 0
  }

  // Invalidate every cached serve grant, forcing one re-authorization per (peer, path) on the next
  // chunk request: this is what makes a revocation reach a transfer already in flight.
  bumpServeEpoch() {
    if (this._protocol) this._protocol.bumpServeEpoch()
  }
}

// A file's content hash without buffering it.
async function hashFileOnDisk(diskPath, size) {
  const hasher = createStreamingHasher({ size })
  for await (const buf of fs.createReadStream(diskPath)) hasher.update(buf)
  return hasher.digest()
}
