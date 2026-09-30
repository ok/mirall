// Construction helpers for engine-level tests. The engine serves only through an authorizer, so a
// test that is not about the gate passes ALLOW_ALL, and one that drives the chunkNeed handler
// directly gives its fake peer the grant a gated content request would have left behind.
import { OverlayProtocolV2 } from '../../src/shared/transfer/backends/overlay/engine/protocol/protocol.js'
import { createPeerRecord } from '../../src/shared/transfer/backends/overlay/engine/protocol/channel.js'
import { HyperOverlayV2 } from '../../src/shared/transfer/backends/overlay/engine/overlay-v2.js'

export const ALLOW_ALL = async () => true

export function makeProtocol(transfer, opts = {}) {
  return new OverlayProtocolV2(transfer, { serveAuthorizer: ALLOW_ALL, ...opts })
}

export function makeOverlay(store, opts = {}) {
  return new HyperOverlayV2(store, { serveAuthorizer: ALLOW_ALL, ...opts })
}

export function grantServe(proto, peer, synthPath, from = null) {
  proto.grants.grant(peer, synthPath, from, proto.grants.epoch)
}

// A fake attached peer: a full peer record over whatever mux and channel stand-ins a test passes,
// adopted into the protocol's peer set under `key`.
export function addPeer(proto, key, fields = {}) {
  const peer = Object.assign(createPeerRecord(fields.mux ?? null, fields.channel ?? { closed: false, close() {} }), fields)
  proto.channel.adoptForTests(key, peer)
  return peer
}
