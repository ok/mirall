// The three outbound membership frames. They leave the swarm because each is addressed: a grant
// and a deny go to ONE peer's channel, a cancel to every open socket — a pending joiner is not in
// any peer's connectedPeers, so there is no membership to address it by.

import b4a from 'b4a'
import { PEER_FRAME } from '../contract/peer-frames.js'
import { sealSck } from '../spaces/sck-seal.js'
import { getProfileKey } from '../spaces/profile.js'
import { socketMsgHandlers, handlerForPeer } from './swarm-registries.js'
import { sendFrame, getLocalBinding } from './identity-frames.js'

// Hand the joiner the SCK AND assert this space's OR-Set root, bound to our identity. The
// joiner pins creatorKey only from this authenticated assertion — never from the bearer
// invite. creatorKeyHex is our own pinned/derived root; granterKey + binding let the joiner
// verify WE are an authorized member making the claim. `epoch` names which SCK epoch the
// sealed key belongs to.
export function sendMembershipGrant(profileKeyHex, topicHex, sckHex, creatorKeyHex, recipientSignerPkEd, { epoch = 0 } = {}) {
  const handler = handlerForPeer(profileKeyHex)
  // Sealed-only: without the recipient's bound signer key we cannot seal, so we refuse to
  // grant rather than fall back to a plaintext SCK a transport observer could capture.
  if (!handler || !recipientSignerPkEd) return false
  try {
    const sckSealed = b4a.toString(sealSck(b4a.from(sckHex, 'hex'), recipientSignerPkEd), 'hex')
    sendFrame(handler, {
      type: PEER_FRAME.MEMBERSHIP_GRANT,
      spaceTopic: topicHex,
      sckSealed,
      epoch,
      creator: creatorKeyHex || null,
      granterKey: b4a.toString(getProfileKey(), 'hex'),
      ...(getLocalBinding() || {}),
    })
    return true
  } catch {
    return false
  }
}

// Withdraw our own pending join request (an ephemeral request-lifecycle signal, not
// convergence gossip): tell connected members so their "wants to join" banner clears. A
// pending joiner isn't admitted anywhere, so it isn't in any peer's connectedPeers — and
// cancelling doesn't promptly close the shared socket — so send over every socket;
// recipients no-op if they hold no matching request.
export function broadcastMembershipCancel(spaceId, topicHex, joinerKey) {
  for (const [, handler] of socketMsgHandlers) {
    try { handler.send(JSON.stringify({ type: PEER_FRAME.MEMBERSHIP_CANCEL, spaceTopic: topicHex, joinerKey })) } catch {}
  }
}

export function sendMembershipDeny(profileKeyHex, topicHex) {
  const handler = handlerForPeer(profileKeyHex)
  if (!handler) return false
  try {
    handler.send(JSON.stringify({ type: PEER_FRAME.MEMBERSHIP_DENY, spaceTopic: topicHex }))
    return true
  } catch {
    return false
  }
}
