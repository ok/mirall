/**
 * HyperOverlayV2 — content-addressed file serving over the V2 protocol.
 *
 * A thin facade over the V2 stack (FileIndex + SyncEngine + TransferManager +
 * OverlayProtocolV2) for the "serve a file to whoever asks, fetch a file from
 * whoever has it" use case — distinct from V1's local chunk-registry blobs.
 *
 * Model (the deliberate post-Hyperdrive design): the canonical bytes are a
 * REAL FILE ON DISK. The index holds only metadata + chunk maps (no blob
 * bytes), so there is no hypercore storage balloon. A peer fetches a file by
 * its content hash; chunks are read from the source file on demand, streamed,
 * hash-verified, and written to the requester's disk.
 *
 * `autoSync` is OFF: this is on-demand content fetch (requestContent →
 * _onContentRequest), NOT Syncthing-style folder push. Registering a file
 * makes it servable; nothing is offered to peers unsolicited.
 *
 * Requester flow mirrors pgh's NetworkFetcher.getContent (production-proven):
 * pre-register a synthetic `content:<hash>` → destPath mapping, requestContent,
 * await the hash-verified transferComplete, walk peers on timeout/mismatch.
 */

import ReadyResource from 'ready-resource'
import fs from 'bare-fs'
import path from 'bare-path'
import os from 'bare-os'
import crypto from 'hypercore-crypto'

import { FileIndex } from './file-index.js'
import { SyncEngine } from './sync-engine.js'
import { TransferManager } from './transfer.js'
import { OverlayProtocolV2 } from './protocol-v2.js'
import { createStreamingHasher } from './chunker.js'

const DEFAULT_PER_PEER_TIMEOUT = 30000
const DEFAULT_IDLE_TIMEOUT = 10000

// [mirall] Stream-verify a file against its overlay content hash WITHOUT buffering
// it — a readFileSync of a multi-GB blob OOMs the worker. Matches
// crypto.data(buffer): blake2b(LEAF_TYPE || uint64-LE(size) || bytes), which is
// exactly createStreamingHasher({ size }). Returns the size so callers can re-seed
// without a second stat.
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
    this._corestore = corestore.namespace(opts.namespace || 'overlay-v2')
    this._destDir = opts.destDir || path.join(os.tmpdir(), 'hyper-overlay-v2-fetch')
    this._journalDir = opts.journalDir || null
    this._partialSuffix = opts.partialSuffix || null // [mirall] §4.17
    this._syncBaseDirs = opts.syncBaseDirs || []
    this._perPeerTimeout = opts.perPeerTimeout || DEFAULT_PER_PEER_TIMEOUT
    this._idleTimeout = opts.idleTimeout || DEFAULT_IDLE_TIMEOUT

    // [mirall] Serve-authorization + identity opts threaded to OverlayProtocolV2.
    // serveAuthorizer gates every inbound content-request; localProfileKey stamps
    // outbound content-requests so the remote's gate can authenticate the asker.
    this._serveAuthorizer = opts.serveAuthorizer || null
    this._localProfileKey = opts.localProfileKey || null

    // [mirall] At-rest key for the local index cores (file-index/index-meta/sync-feed).
    this._indexEncryptionKey = opts.indexEncryptionKey || null

    // [mirall] serve-side download telemetry (sender-side download indicator).
    this._onServeStart = opts.onServeStart || null
    this._onChunkServe = opts.onChunkServe || null
    this._onServeEnd = opts.onServeEnd || null
    this._onServeControl = opts.onServeControl || null
    this._onServeProgress = opts.onServeProgress || null

    // Shared maps the protocol reads: overlayPath → diskPath (for serving an
    // offered/known path), contentHash → diskPath (fast path for content
    // requests). Both populated by registerFile.
    this._filePaths = new Map()
    this._contentHashPaths = new Map()

    // contentHash → pending fetch { destPath, finish, timers, bytesReceived }
    this._pendingContent = new Map()

    // Built lazily on first use (Hyperdrive-style: a drive that never touches
    // its blobs core never opens one). A daemon that never registers, serves,
    // or connects a peer for attachments pays nothing — no feed, no index.
    this._index = null
    this._sync = null
    this._transfer = null
    this._protocol = null
    this._stackPromise = null
  }

  // The protocol must exist synchronously when attachProtocol is called —
  // protomux will NOT pair a channel created after the remote opened theirs
  // (verified). So the stack is built at ready time. _ensure stays as the
  // idempotent builder (used by register/fetch, and as a safety net).
  async _open () { await this._ensure() }

  async _close () {
    // Only tear down what was actually built.
    if (this._protocol) this._protocol.destroy()
    if (this._sync) await this._sync.close()
    if (this._index) await this._index.close()
  }

  // Lazily build the V2 stack. Idempotent + concurrency-safe (a single
  // in-flight promise is shared). No-op cost once built.
  _ensure () {
    if (this._protocol) return Promise.resolve()
    if (this._stackPromise) return this._stackPromise
    this._stackPromise = (async () => {
      const index = new FileIndex(this._corestore, { encryptionKey: this._indexEncryptionKey })
      await index.ready()
      const sync = new SyncEngine(index, this._corestore, { encryptionKey: this._indexEncryptionKey })
      await sync.ready()
      const transfer = new TransferManager(index, { journalDir: this._journalDir, partialSuffix: this._partialSuffix })
      const protocol = new OverlayProtocolV2(sync, transfer, {
        filePaths: this._filePaths,
        contentHashPaths: this._contentHashPaths,
        syncBaseDirs: this._syncBaseDirs,
        autoSync: false,
        serveAuthorizer: this._serveAuthorizer,   // [mirall] serve gate
        localProfileKey: this._localProfileKey,    // [mirall] outbound identity
        onSynced: (info) => this._onSynced(info),
        onChunkProgress: (info) => this._onChunkProgress(info),
        onServeStart: this._onServeStart,
        onChunkServe: this._onChunkServe,
        onServeEnd: this._onServeEnd,
        onServeControl: this._onServeControl,
        onServeProgress: this._onServeProgress
      })
      try { fs.mkdirSync(this._destDir, { recursive: true }) } catch {}
      if (this._journalDir) { try { fs.mkdirSync(this._journalDir, { recursive: true }) } catch {} }
      this._index = index
      this._sync = sync
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

  // The overlay's local-only cores (file-index + version marker + sync feed), so the
  // leftover scan can treat them as wanted and the storage breakdown can size them.
  localCores () {
    const cores = this._index ? this._index.cores : []
    if (this._sync?.feed) cores.push(this._sync.feed)
    return cores
  }

  cleanJournals (maxAge) { try { return this._transfer?.cleanJournals(maxAge) || [] } catch { return [] } }

  /**
   * Make an on-disk file servable by its content hash.
   * @param {string} overlayPath logical path, e.g. '/attachments/<oid>'
   * @param {string} diskPath absolute path to the canonical bytes on disk
   * @param {object} [meta]
   *  meta.contentHash preferred — the oid the caller already computed
   *  meta.size file size (avoids an extra stat if known)
   * @returns {Promise<{ contentHash, size } | null>} null if the source vanished
   */
  async registerFile (overlayPath, diskPath, meta = {}) {
    await this._ensure()
    // [mirall] Source can vanish between prepare and register (a file moved out of a
    // shared folder mid-scan). Nothing to serve — bail with null instead of throwing
    // so a routine move doesn't crash the publish path.
    let stat
    try {
      stat = fs.statSync(diskPath)
    } catch {
      return null
    }
    const size = typeof meta.size === 'number' ? meta.size : stat.size
    const contentHash = meta.contentHash || await hashFileOnDisk(diskPath, size)

    await this._index.putFile(overlayPath, { contentHash, size, mtime: stat.mtimeMs })
    this._filePaths.set(overlayPath, diskPath)
    this._contentHashPaths.set(contentHash, diskPath)
    // Build (and cache) the chunk map so a content request can stream
    // immediately without re-chunking under the request. [mirall] meta.prepare:false
    // skips this eager full second read of the file — the file is already servable
    // via the maps above and the serve path (_onContentRequest) chunks lazily on
    // first request; used by the loose publish path so files:add doesn't block on it.
    if (meta.prepare !== false) await this._transfer.prepareFile(diskPath, overlayPath)
    // Record in the local change feed (used by the protocol's markSynced
    // bookkeeping; with autoSync off it is not broadcast).
    await this._sync.logPut(overlayPath, { contentHash, size, mtime: stat.mtimeMs })
    return { contentHash, size }
  }

  // [mirall] One-pass hash + chunk-map build for the publish path: streams the file
  // ONCE, persists the content-addressed chunk map (durable in FileIndex), and
  // returns the content hash. Replaces a hash-only pass plus a lazy fetch-time
  // re-chunk with a single read, so the first fetcher never waits on chunk indexing.
  async prepareForServe (diskPath, opts = {}) {
    await this._ensure()
    const prepared = await this._transfer.prepareFile(diskPath, '/mir-prep' + diskPath, { onProgress: opts.onProgress, byHashOnly: true, signal: opts.signal })
    return prepared ? { contentHash: prepared.contentHash, size: prepared.size } : null
  }

  async evictContent (contentHash) {
    await this._ensure()
    return this._index.evictContent(contentHash)
  }

  async compactIndex (opts) {
    await this._ensure()
    return this._index.compact(opts)
  }

  /**
   * Fetch a file by its content hash. Serves from the local disk copy if we
   * have it; otherwise pulls from a connected peer that does (hash-verified).
   * @param {string} contentHash
   * @param {object} [opts] opts.timeout (idle), opts.destPath
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
    for (let waited = 0; this._protocol._peers.size === 0 && waited < peerWaitMs; waited += 100) {
      await new Promise(r => setTimeout(r, 100))
    }
    if (this._protocol._peers.size === 0) {
      // No fetchContent will run, so drop any cancel recorded during the wait — a
      // stale marker would otherwise cancel the next fetch of the same content. [mirall]
      this._protocol.clearCancelPending(contentHash)
      return null
    }

    // Multi-source: fetch chunks in parallel from ALL connected peers that
    // have the file (torrent-style). The scheduler dedups + fails over.
    const peers = [...this._protocol._peers.values()]
    // opts.mirrorSpool: store the verified blob CONTENT-ADDRESSED at
    // <mirrorSpool>/<contentHash> rather than a throwaway destDir name. This is
    // the overlay-mirror path — a forge backend with no working tree fetches a
    // repo's large files into a content-addressed spool so it durably re-serves
    // them (via the <syncBaseDir>/<contentHash> resolution in _onContentRequest).
    let destPath
    if (opts.destPath) {
      destPath = opts.destPath
    } else if (opts.mirrorSpool) {
      try { fs.mkdirSync(opts.mirrorSpool, { recursive: true }) } catch {}
      destPath = path.join(opts.mirrorSpool, contentHash)
    } else {
      destPath = path.join(
        this._destDir,
        'blob-' + contentHash + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
      )
    }
    // Whole-file integrity is verified INCREMENTALLY during the transfer (the
    // scheduler passes contentHash to TransferManager, which hashes the file in
    // offset order as chunks land and rejects in finalize on a mismatch). So the
    // assembled file is already verified here — no trailing whole-file re-read.
    let result
    try {
      result = await this._protocol.fetchContent(contentHash, peers, {
        destPath,
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
    // Seeding multiplication: register the verified blob locally so this node
    // now SERVES these chunks to other peers too. A file held by N peers then
    // gets faster as more peers fetch it (torrent-style). Best-effort — the
    // fetch still succeeds even if re-registration fails. Skipped if a peer
    // raced us to register the same hash (registerFile is idempotent-safe).
    // [mirall] : opt-out for consumers that should hold nothing (reSeed:false).
    if (opts.reSeed !== false && !this._contentHashPaths.has(contentHash)) {
      try {
        await this.registerFile('/attachments/' + contentHash, destPath, { contentHash, size })
      } catch {}
    }
    return { destPath, local: false, size }
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

  _destPathFor (contentHash) {
    return path.join(this._destDir, 'blob-' + contentHash)
  }

  _fetchFromPeer (peer, contentHash, opts = {}) {
    const syntheticPath = 'content:' + contentHash
    const destPath = path.join(
      this._destDir,
      'blob-' + contentHash + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
    )
    // The protocol's chunk handlers write to whatever _filePaths maps the
    // synthetic path to. Per-attempt destPath so concurrent peer tries don't
    // clobber one another.
    this._filePaths.set(syntheticPath, destPath)

    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (err, result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        clearTimeout(pending.idleTimer)
        this._pendingContent.delete(contentHash)
        if (err) reject(err); else resolve(result)
      }
      const timer = setTimeout(() => {
        finish(new Error('content request timed out: ' + contentHash.slice(0, 12)))
      }, opts.timeout || this._perPeerTimeout)
      const idleFire = () => finish(new Error('peer went silent mid-stream: ' + contentHash.slice(0, 12)))
      const pending = {
        syntheticPath, destPath, finish, peer, contentHash,
        bytesReceived: 0,
        idleTimer: setTimeout(idleFire, this._idleTimeout),
        idleFire
      }
      this._pendingContent.set(contentHash, pending)
      this._protocol.requestContent(peer, contentHash, null)
    })
  }

  _onChunkProgress (info) {
    if (!info || !info.path || !info.path.startsWith('content:')) return
    const contentHash = info.path.slice('content:'.length)
    const pending = this._pendingContent.get(contentHash)
    if (!pending) return
    pending.bytesReceived += (info.bytes || 0)
    clearTimeout(pending.idleTimer)
    pending.idleTimer = setTimeout(pending.idleFire, this._idleTimeout)
  }

  // The V2 chunk flow does NOT verify the reassembled file against the
  // advertised hash (that's the caller's job in this protocol). We do it here
  // so fetchFile never returns un-verified bytes.
  _onSynced (info) {
    if (!info || info.direction !== 'pull') return
    if (!info.path || !info.path.startsWith('content:')) return
    const contentHash = info.path.slice('content:'.length)
    const pending = this._pendingContent.get(contentHash)
    if (!pending) return
    try {
      const data = fs.readFileSync(pending.destPath)
      const actual = crypto.data(data).toString('hex')
      if (actual !== contentHash) {
        pending.finish(Object.assign(
          new Error('content-hash mismatch: expected ' + contentHash.slice(0, 12) + '…, got ' + actual.slice(0, 12) + '…'),
          { code: 'EHASHMISMATCH', expected: contentHash, actual }
        ))
        return
      }
      pending.finish(null, data)
    } catch (err) {
      pending.finish(err)
    }
  }
}

// Stream a file through the chunker's hasher to get its oid without buffering
// the whole file in memory (matches /api/upload's createStreamingHasher oid).
async function hashFileOnDisk (diskPath, size) {
  const hasher = createStreamingHasher({ size })
  for await (const buf of fs.createReadStream(diskPath)) hasher.update(buf)
  return hasher.digest()
}
