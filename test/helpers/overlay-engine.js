// Construction helpers for engine-level tests. The engine serves only through an authorizer, so a
// test that is not about the gate passes ALLOW_ALL, and one that drives _onChunkNeed directly gives
// its fake peer the grant a gated content request would have left behind.
import { OverlayProtocolV2 } from '../../src/shared/transfer/backends/overlay/engine/protocol-v2.js'
import { HyperOverlayV2 } from '../../src/shared/transfer/backends/overlay/engine/overlay-v2.js'

export const ALLOW_ALL = async () => true

export function makeProtocol(transfer, opts = {}) {
  return new OverlayProtocolV2(transfer, { serveAuthorizer: ALLOW_ALL, ...opts })
}

export function makeOverlay(store, opts = {}) {
  return new HyperOverlayV2(store, { serveAuthorizer: ALLOW_ALL, ...opts })
}

export function grantServe(proto, peer, synthPath, from = null) {
  peer.authorizedServe.set(synthPath, { from, epoch: proto._serveEpoch })
}
