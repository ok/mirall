// share-wait: a member tells a file's owner it is waiting on a hash the owner is still computing, so
// the owner's row can show who is waiting — the inverse of share-prepare-progress, and behind the
// same switch on both ends. Unicast to the owner over the control channel, ephemeral both ways. The
// member's waiting set is share-wait-set.js; which notices the owner accepts is share-wait-intake.js.
import b4a from 'b4a'
import { PEER_FRAME } from '../contract/peer-frames.js'
import { getProfileKey } from '../spaces/profile.js'
import { getOwnEntry } from '../shares/own-catalog.js'
import { isSharePrepareProgressEnabled } from '../core/runtime-config.js'
import { createLogger } from '../core/logger.js'
import { createShareWaitSet } from '../transfer/share-wait-set.js'
import { markWaiting, clearWaiting } from '../transfer/serve-ledger.js'
import { connectedPeers, safeSend, authorizedOn } from './swarm-registries.js'
import { createShareWaitIntake, SHARE_WAIT_VERDICT } from './share-wait-intake.js'

const log = createLogger('share-wait')

function sendShareWait(ownerKey, payload) {
  if (!isSharePrepareProgressEnabled()) return false
  const peer = connectedPeers.get(ownerKey)
  if (!peer?.spaces.has(payload.spaceId)) return false
  const self = getProfileKey()
  if (!self) return false
  return safeSend(peer, JSON.stringify({ type: PEER_FRAME.SHARE_WAIT, profileKey: b4a.toString(self, 'hex'), ...payload }))
}

// The member's waiting set for this process; share-wait-set.js states its rules.
export const memberWaits = createShareWaitSet({ send: sendShareWait })

const intake = createShareWaitIntake({
  enabled: isSharePrepareProgressEnabled,
  authorizedOn,
  inSpace: (profileKey, spaceId) => !!connectedPeers.get(profileKey)?.spaces.has(spaceId),
  ownEntry: getOwnEntry,
  markWaiting,
  clearWaiting,
})

// debug, not warn: any peer on the topic can send one, and a louder level would hand it a log-spam
// primitive.
export function handleShareWaitFrame(socket, msg) {
  return intake.handle(socket, msg).then((verdict) => {
    if (verdict !== SHARE_WAIT_VERDICT.MARKED && verdict !== SHARE_WAIT_VERDICT.CLEARED) log.debug('share-wait dropped:', verdict)
  }, (err) => log.debug('share-wait handling failed:', err?.message || err))
}

export function resetShareWait() {
  memberWaits.clear()
  intake.reset()
}
