// SPDX-License-Identifier: AGPL-3.0-only
// Derived from hyper-overlay lib/protocol-v2.js @ 6cac8ee (v0.2.9), Copyright (C) 2026 the
// hyper-overlay authors, licensed AGPL-3.0. Modified for Mirall in 2026; PROVENANCE.md
// lists the changes and carries the full license notice.

// Serving a granted hash. A content request is admitted through the serve gate, resolved to a disk
// path and answered with the paged chunk map; each chunkNeed then runs the chunk loop: read,
// re-check the grant, pay the upload cap (with keep-alives), send, wait for drain, re-check again.
// A deny is silent at every step, indistinguishable from "not held".

import fs from 'bare-fs'
import { selectTier } from '../chunker.js'
import { contentHashOf, contentPath } from '../content-path.js'
import { sendChunkHashes } from '../wire/paging.js'
import { CONTROL_STOPPED } from '../wire/messages.js'

// How often a serve loop parked on our own upload cap tells the downloader it is still there.
// Must stay well under the downloader's 30 s no-progress watchdog: waiting on a cap puts nothing on
// the wire, so without this a capped but healthy holder reads as a wedged one.
const KEEPALIVE_INTERVAL_MS = 5000

export class ServeSession {
  // `contentHashPaths` maps a hash to the file that serves it; `fileIndex` holds the chunk maps;
  // `transfer.prepareFile` chunks a file that has none yet.
  constructor({ fileIndex, transfer, contentHashPaths, grants, fds, drain, uploadLimiter = null, keepAliveInterval, callbacks: { onServeStart = null, onChunkServe = null, onServeControl = null, onServeProgress = null } = {} }) {
    this._fileIndex = fileIndex
    this._transfer = transfer
    this._contentHashPaths = contentHashPaths
    this._grants = grants
    this._fds = fds
    this._drain = drain
    this._uploadLimiter = uploadLimiter
    this._keepAliveInterval = keepAliveInterval || KEEPALIVE_INTERVAL_MS
    this._onServeStart = onServeStart || null
    this._onChunkServe = onChunkServe || null
    this._onServeControl = onServeControl || null
    this._onServeProgress = onServeProgress || null
    // The disk path each granted hash is served from, set when a request is granted.
    this._served = new Map()
  }

  async onContentRequest(peer, msg) {
    // Captured BEFORE the authorize await: a membership change during it leaves the grant stamped
    // with the old epoch, so the next chunk re-checks it.
    const epoch = this._grants.epoch
    const from = msg.from || null
    if (!(await this._grants.admit(peer, from, msg.contentHash))) return
    const diskPath = this._resolve(msg.contentHash)
    if (!diskPath) return

    const synthPath = contentPath(msg.contentHash)
    this._served.set(msg.contentHash, diskPath)
    this._grants.grant(peer, synthPath, from, epoch)
    // A serve that cannot produce a map, by a null or a throw, leaves neither the grant nor the
    // served path behind: no serve-end fires later for a serve that never started.
    let map = null
    try { map = await this._chunkMapFor(msg.contentHash, diskPath) } finally {
      if (!map) {
        this._served.delete(msg.contentHash)
        this._grants.drop(peer, synthPath)
      }
    }
    if (!map) return
    sendChunkHashes(peer, synthPath, map.tier, map.chunks)
    if (this._onServeStart) {
      let total = 0
      for (const c of map.chunks) total += c.length || 0
      try { this._onServeStart({ path: synthPath, peer, from, total }) } catch {}
    }
  }

  // Bytes are served ONLY for a synthetic path this peer was granted, so a peer cannot pull bytes
  // by sending chunkNeed without passing the serve gate.
  async onChunkNeed(peer, msg) {
    if (!(await this._grants.stillAuthorized(peer, msg.path))) return
    const hash = contentHashOf(msg.path)
    const diskPath = hash && this._served.get(hash)
    if (!diskPath) return
    const chunkMap = await this._fileIndex.getChunkMapByHash(hash)
    if (!chunkMap) return
    for (let i = 0; i < msg.indices.length; i++) {
      const index = msg.indices[i]
      if (index >= chunkMap.length) continue
      const more = i < msg.indices.length - 1
      if (!(await this._serveOne(peer, msg.path, index, chunkMap[index], diskPath, more))) return
    }
  }

  // A downloader paused or stopped a hash we serve.
  onTransferControl(peer, msg) {
    if (!this._onServeControl) return
    const { synthPath, from } = this._grants.fromOf(peer, msg.contentHash)
    if (!from) return
    const state = msg.state === CONTROL_STOPPED ? 'stopped' : 'paused'
    try { this._onServeControl({ path: synthPath, peer, from, state }) } catch {}
  }

  // A downloader reported the bytes it already holds for a hash we serve.
  onTransferProgress(peer, msg) {
    if (!this._onServeProgress) return
    const { synthPath, from } = this._grants.fromOf(peer, msg.contentHash)
    if (!from) return
    try { this._onServeProgress({ path: synthPath, peer, from, have: msg.have || 0 }) } catch {}
  }

  // The peer's channel closed: detaching its upload handle resolves any take() parked on the cap
  // with 0 and hands back budget charged for bytes that will never go out.
  releaseUpload(peer) {
    if (!peer.uploadStream) return
    try { peer.uploadStream.detach() } catch {}
    peer.uploadStream = null
  }

  /** @internal */
  servedPath(contentHash) { return this._served.get(contentHash) ?? null }

  _resolve(contentHash) {
    const diskPath = this._contentHashPaths.get(contentHash)
    return diskPath && fileExists(diskPath) ? diskPath : null
  }

  // Chunking is deterministic on bytes, so a map computed at publish, by an earlier serve or
  // before a restart is reused instead of re-reading the whole file before the first byte ships.
  async _chunkMapFor(contentHash, diskPath) {
    const stored = await this._fileIndex.getChunkMapByHash(contentHash)
    if (stored) {
      let size = 0
      try { size = fs.statSync(diskPath).size } catch {}
      return { tier: selectTier(size), chunks: stored }
    }
    const prepared = await this._transfer.prepareFile(diskPath)
    if (!prepared) return null
    // prepareFile persists a map only for large files; the serve loop resolves every map by hash.
    if (!await this._fileIndex.hasChunkMapByHash(contentHash)) await this._fileIndex.putChunkMapByHash(contentHash, prepared.chunks)
    return { tier: prepared.tier, chunks: prepared.chunks }
  }

  // One chunk. Each wait (the read, the cap, the drain) is a revocation window, so the grant is
  // re-checked after it, and after the read BEFORE the cap is charged: a revoked chunk is never
  // paid for. Returns false when the loop must stop.
  async _serveOne(peer, synthPath, index, chunk, diskPath, more) {
    const data = await this._fds.read(peer, diskPath, chunk)
    if (peer.channel?.closed) return false
    if (!data) return true
    if (!(await this._grants.stillAuthorized(peer, synthPath))) return false
    if (!(await this._pay(peer, synthPath, index, data.length))) return false
    const flushed = peer.msgs.chunkData.send({ path: synthPath, index, data })
    if (this._onChunkServe) {
      try { this._onChunkServe({ path: synthPath, index, bytes: data.length, peer, from: this._grants.fromOf(peer, contentHashOf(synthPath)).from }) } catch {}
    }
    // chunkData, the control channel and the replication carrying a freshly shared folder all
    // share one Noise stream. On backpressure stop producing content until it drains, or a peer
    // mid-download never sees a new share.
    if (flushed === false && more) {
      if (!(await this._drain.wait(peer))) return false
      if (!(await this._grants.stillAuthorized(peer, synthPath))) return false
    }
    return true
  }

  // Charge the upload cap against this peer's own stream, so concurrent serve loops share the cap
  // by bytes instead of racing. take() resolves with the bytes paid; 0 means the wait was aborted
  // (limiter destroyed, or the handle detached on close) and sending anyway would put unmetered
  // bytes on the wire. Past a successful take the bytes are debited, so a bail refunds them.
  async _pay(peer, synthPath, index, bytes) {
    const uploadStream = this._uploadStreamFor(peer)
    if (!uploadStream || uploadStream.isUnlimited()) return true
    const paid = await this._takeWithKeepAlive(peer, synthPath, index, bytes, uploadStream)
    if (paid <= 0) return false
    if (peer.channel?.closed || !(await this._grants.stillAuthorized(peer, synthPath))) {
      uploadStream.give(paid)
      return false
    }
    return true
  }

  // Per peer, not per limiter: the limiter splits the cap between its streams, so one handle shared
  // by every serve loop would make them race. Never minted for a closed channel: a loop resumed
  // after releaseUpload would create an orphan nothing detaches, which takes a share of every
  // refill and blocks every live transfer.
  _uploadStreamFor(peer) {
    if (!this._uploadLimiter || peer.channel?.closed) return null
    if (!peer.uploadStream) peer.uploadStream = this._uploadLimiter.stream()
    return peer.uploadStream
  }

  // Pay for a chunk while telling the downloader we are alive. Our cap is invisible to it, so a
  // wait longer than its watchdog fails a transfer that is merely paced. The downloader re-arms
  // only for a chunk it is owed (the scheduler's notePeerAlive), so this cannot hold a fetch open.
  // A grant dropped while parked stops the announcements too: they name a hash, and continuing
  // would tell a revoked peer we hold and serve it.
  async _takeWithKeepAlive(peer, synthPath, index, bytes, uploadStream) {
    const contentHash = contentHashOf(synthPath)
    if (!peer.msgs.keepAlive || !contentHash) return uploadStream.take(bytes)
    const timer = setInterval(() => {
      if (peer.channel?.closed || !this._grants.holds(peer, synthPath)) return
      try { peer.msgs.keepAlive.send({ contentHash, index }) } catch {}
    }, this._keepAliveInterval)
    // Unref'd: take() resolving is what advances the loop, never this timer.
    timer.unref?.()
    // try/finally: a take() that returns a plain value or throws synchronously must still clear it.
    try {
      return await uploadStream.take(bytes)
    } finally {
      clearInterval(timer)
    }
  }
}

// A cold-restart map entry whose file is gone is not held.
function fileExists(p) {
  try { return fs.statSync(p).isFile() } catch { return false }
}
