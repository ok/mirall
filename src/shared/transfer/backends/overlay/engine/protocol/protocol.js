// SPDX-License-Identifier: AGPL-3.0-only
// Derived from hyper-overlay lib/protocol-v2.js @ 6cac8ee (v0.2.9), Copyright (C) 2026 the
// hyper-overlay authors, licensed AGPL-3.0. Modified for Mirall in 2026; PROVENANCE.md
// lists the changes and carries the full license notice.

// OverlayProtocolV2 — the hyper-overlay/v2 channel: content-addressed fetch and gated serve. This
// root builds the siblings, hands them their collaborators, routes each slot to its handler and
// runs the channel-close fan-out and destroy. It holds no protocol state of its own.

import { PeerChannel } from './channel.js'
import { ServeGrants } from './serve-grants.js'
import { ServeFds } from './serve-fds.js'
import { ServeSession } from './serve-session.js'
import { FetchSession } from './fetch-session.js'
import { createDrainWaiter } from './transport-probe.js'
import { createChunkHashAssembler } from '../wire/paging.js'

export class OverlayProtocolV2 {
  // `transfer` is the receive verbs, serve reads and prepare; `opts.fileIndex` holds the chunk maps
  // and `opts.contentHashPaths` maps a hash to the file that serves it. `opts.serveAuthorizer`
  // gates every serve and is required.
  constructor(transfer, opts = {}) {
    if (typeof opts.serveAuthorizer !== 'function') throw new TypeError('serveAuthorizer is required: the engine serves only through it')
    this.channel = new PeerChannel({
      minVersion: opts.minVersion,
      onPeerOpen: opts.onPeerOpen || null,
      onPeerRejected: opts.onPeerRejected || null,
      onClosed: (peer) => this._onPeerClosed(peer),
    })
    const peers = () => this.channel.peers()
    this.grants = new ServeGrants({ authorize: opts.serveAuthorizer, onServeEnd: opts.onServeEnd || null, peers })
    this.serveFds = new ServeFds({ reads: transfer, peers, idleMs: opts.serveFdIdleMs })
    this.pages = createChunkHashAssembler()
    this.drain = createDrainWaiter({ drainTimeout: opts.drainTimeout, drainNoProgress: opts.drainNoProgress })
    this.serve = new ServeSession({
      fileIndex: opts.fileIndex,
      transfer,
      contentHashPaths: opts.contentHashPaths || new Map(),
      grants: this.grants,
      fds: this.serveFds,
      drain: this.drain,
      uploadLimiter: opts.uploadLimiter || null,
      keepAliveInterval: opts.keepAliveInterval,
      callbacks: {
        onServeStart: opts.onServeStart,
        onChunkServe: opts.onChunkServe,
        onServeControl: opts.onServeControl,
        onServeProgress: opts.onServeProgress,
      },
    })
    this.fetches = new FetchSession({
      transfer,
      pages: this.pages,
      peers,
      downloadLimiter: opts.downloadLimiter || null,
      localProfileKey: opts.localProfileKey || null,
    })
    // Handlers return their promise, so a test can await one; the channel's dispatch drops it.
    this.handlers = Object.freeze({
      chunkHashes: (peer, msg) => this.fetches.onChunkHashes(peer, msg),
      chunkNeed: (peer, msg) => this.serve.onChunkNeed(peer, msg),
      chunkData: (peer, msg) => this.fetches.onChunkData(peer, msg),
      contentRequest: (peer, msg) => this.serve.onContentRequest(peer, msg),
      transferControl: (peer, msg) => this.serve.onTransferControl(peer, msg),
      transferProgress: (peer, msg) => this.serve.onTransferProgress(peer, msg),
      keepAlive: (peer, msg) => this.fetches.onKeepAlive(peer, msg),
    })
  }

  attach(mux) { return this.channel.attach(mux, this.handlers) }
  detach(mux) { this.channel.detach(mux) }
  peers() { return this.channel.peers() }
  get peerCount() { return this.channel.size }

  fetchContent(contentHash, peers, opts) { return this.fetches.fetch(contentHash, peers, opts) }
  cancelContent(contentHash, opts) { return this.fetches.cancel(contentHash, opts) }
  sendStopControl(contentHash) { this.fetches.sendStop(contentHash) }
  clearCancelPending(contentHash) { this.fetches.clearCancelPending(contentHash) }
  revokeServes(predicate) { return this.grants.revoke(predicate) }
  bumpServeEpoch() { this.grants.bumpEpoch() }

  destroy() {
    this.serveFds.stop()
    for (const peer of this.channel.peers()) {
      this.serveFds.closePeer(peer)
      peer.channel.close()
    }
    this.channel.clear()
  }

  // The order matters: the upload handle is detached first so a take() parked on the cap resolves
  // 0 instead of sending to a dead channel; then the peer's fds and half-paged maps go; then every
  // fetch reassigns its inflight chunks; last the sender-side indicator hears each serve ended.
  _onPeerClosed(peer) {
    this.serve.releaseUpload(peer)
    this.serveFds.closePeer(peer)
    this.pages.forget(peer)
    this.fetches.removePeer(peer)
    this.grants.endAll(peer)
  }
}
