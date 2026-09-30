// SPDX-License-Identifier: AGPL-3.0-only
// Derived from hyper-overlay lib/protocol-v2.js @ 6cac8ee (v0.2.9), Copyright (C) 2026 the
// hyper-overlay authors, licensed AGPL-3.0. Modified for Mirall in 2026; PROVENANCE.md
// lists the changes and carries the full license notice.

// The attached peers: one protomux channel per mux with every slot in table order, the
// minVersion handshake gate, and exactly one close report per peer. Knows nothing about serving
// or fetching.

import { PROTOCOL, VERSION, MIN_VERSION, CAPABILITIES, SLOTS, isRetired } from '../wire/slots.js'
import { handshake, UNANNOUNCED_HANDSHAKE } from '../wire/messages.js'

/**
 * One attached overlay channel. Fields owned by a sibling: `authorizedServe` (serve-grants),
 * `askedFor` (fetch-session), `uploadStream` (serve-session).
 * @typedef {object} PeerRecord
 * @property {object} mux
 * @property {object} channel
 * @property {Record<string, { send(msg: object): boolean }>} msgs  one sender per live slot
 * @property {number|null} remoteVersion  null until onopen; 1 for an unannounced peer
 * @property {number} remoteCaps          capability bits; 0 until onopen
 * @property {boolean} rejected           below minVersion: its frames are dropped
 * @property {Map<string, { from: string|null, epoch: number }>} authorizedServe
 * @property {Set<string>} askedFor       content hashes we sent this peer a content request for
 * @property {object|null} uploadStream   this peer's handle on the upload cap
 */

/** @returns {PeerRecord} */
export function createPeerRecord(mux, channel) {
  return {
    mux,
    channel,
    msgs: {},
    remoteVersion: null,
    remoteCaps: 0,
    rejected: false,
    authorizedServe: new Map(),
    askedFor: new Set(),
    uploadStream: null,
  }
}

export class PeerChannel {
  // onPeerOpen({ peer, version, capabilities }) fires once the remote's version and caps are known
  // and accepted; onPeerRejected fires instead, just before the channel closes, when the remote is
  // below minVersion. Both must be synchronous: a throw is contained, an async rejection is not.
  constructor({ minVersion, onPeerOpen = null, onPeerRejected = null, onClosed }) {
    this._minVersion = minVersion ?? MIN_VERSION
    this._onPeerOpen = onPeerOpen
    this._onPeerRejected = onPeerRejected
    this._onClosed = onClosed
    this._peers = new Map()
  }

  // `handlers` maps a live slot's name to (peer, msg) => void.
  attach(mux, handlers) {
    if (this._peers.has(mux)) return this._peers.get(mux)
    const channel = mux.createChannel({
      protocol: PROTOCOL,
      id: null,
      // Without it protomux never encodes what open() is handed and calls onopen with nothing.
      handshake,
      onopen: (hs) => {
        const peer = this._peers.get(mux)
        if (peer) this._onOpen(peer, hs)
      },
      onclose: () => {
        const peer = this._peers.get(mux)
        this._peers.delete(mux)
        if (peer) this._onClosed(peer)
      },
    })
    if (!channel) return null
    const peer = createPeerRecord(mux, channel)
    // A peer refused by the minVersion gate is never dispatched to: protomux calls onopen and then
    // drains frames the remote pipelined behind its open, against a record captured before our
    // close() detached the channel. A handler runs synchronously (protomux delivers a burst of
    // frames in order within one read) and its failure ends at this dispatch: a throw reaching
    // protomux would tear down the whole mux.
    const recv = (fn) => (msg) => {
      if (peer.rejected) return
      let pending
      try { pending = fn(peer, msg) } catch { return }
      if (pending && typeof pending.catch === 'function') pending.catch(() => {})
    }
    for (const slot of SLOTS) {
      if (isRetired(slot)) { channel.addMessage({ encoding: slot.codec }); continue }
      peer.msgs[slot.name] = channel.addMessage({ encoding: slot.codec, onmessage: recv(handlers[slot.name]) })
    }
    this._peers.set(mux, peer)
    channel.open({ version: VERSION, capabilities: CAPABILITIES })
    return peer
  }

  // The close fan-out runs exactly once, whether onclose fires during close() or after.
  detach(mux) {
    const peer = this._peers.get(mux)
    if (!peer) return
    peer.channel.close()
    if (this._peers.get(mux) !== peer) return
    this._peers.delete(mux)
    this._onClosed(peer)
  }

  peers() { return this._peers.values() }

  get size() { return this._peers.size }

  clear() { this._peers.clear() }

  /** @internal */
  adoptForTests(key, peer) { this._peers.set(key, peer) }

  // A peer whose open frame carried no handshake decodes to UNANNOUNCED_HANDSHAKE (v1, no caps), so
  // a behaviour gated on `peer.remoteCaps` is off against it without a special case.
  _onOpen(peer, hs) {
    const announced = hs || UNANNOUNCED_HANDSHAKE
    peer.remoteVersion = announced.version
    peer.remoteCaps = announced.capabilities
    if (announced.version < this._minVersion) {
      if (this._onPeerRejected) {
        try { this._onPeerRejected({ peer, version: announced.version, capabilities: announced.capabilities, minVersion: this._minVersion }) } catch {}
      }
      // Closes only this channel: the socket, its control channel and replication stay up.
      peer.rejected = true
      peer.channel.close()
      return
    }
    if (this._onPeerOpen) {
      try { this._onPeerOpen({ peer, version: announced.version, capabilities: announced.capabilities }) } catch {}
    }
  }
}
