// The two identity-asserting frames we send: `handshake` for a space we hold a drive in, and
// `membership:request` for one we are still pending in. Both carry a signature binding our profile
// key to this socket's Noise key, so the receiver can attribute them to a member (verified in
// handshake-guard.js) and cannot replay them on another connection.
import b4a from 'b4a'
import { getProfileKey, getProfile, getIdentitySigner } from '../spaces/profile.js'
import { getSpace } from '../spaces/space.js'
import { getDrive } from '../spaces/space-drives.js'
import { getPeerFrameMaxBytes, joinRequestAvatarMaxBytes } from '../core/runtime-config.js'
import { catalogKeyField, ownLooseCatalogPublish } from '../shares/share-catalog.js'
import { sanitizeAvatar } from '../contract/identity-limits.js'
import { PEER_FRAME } from '../contract/peer-frames.js'
import { signNoiseBinding } from './handshake-guard.js'
import { spaceTopics, socketMsgHandlers, announceLedger } from './swarm-registries.js'
import { createLogger } from '../core/logger.js'

const log = createLogger('identity-frames')

// Read at call time: the Swarm subsystem reassigns the handle across a restart.
let getSwarm = () => null

export function initIdentityFrames(deps) {
  getSwarm = deps.getSwarm
}

// Proof that this connection's holder controls profileKey: a signature over our own
// (ephemeral) Noise static key by the profile signer, plus the signer key + manifest
// namespace the verifier needs to tie the signer back to profileKey. The Noise key is
// fixed for the swarm's lifetime, so compute it once; cleared on teardown.
// The binding covers noise||driveKey, so it varies per space (the Noise key is fixed,
// the driveKey isn't). Cache per driveKey ('' = the no-drive form for membership:request/grant).
const localBindings = new Map()
export function getLocalBinding(driveKeyHex = '') {
  if (localBindings.has(driveKeyHex)) return localBindings.get(driveKeyHex)
  const signer = getIdentitySigner()
  const noiseKey = getSwarm()?.keyPair?.publicKey
  if (!signer || !noiseKey) return null
  const driveKeyBuf = driveKeyHex ? b4a.from(driveKeyHex, 'hex') : null
  const binding = {
    sig: signNoiseBinding(noiseKey, signer.secretKey, driveKeyBuf),
    signerKey: b4a.toString(signer.publicKey, 'hex'),
    signerNs: b4a.toString(signer.namespace, 'hex'),
  }
  localBindings.set(driveKeyHex, binding)
  return binding
}

// Send path for the frames carrying variable-length content (an identity's name, avatar and
// catalog keys). Each is judged by the same byte cap we enforce on receive, and one over it is
// dropped there before it is parsed — so the only trace of the failure would be a warn line on the
// OTHER machine, which is the wrong one to diagnose from. Say it here, at error level, on the
// machine that built the frame.
export function sendFrame(msgHandler, frame) {
  const str = JSON.stringify(frame)
  const maxBytes = getPeerFrameMaxBytes()
  // Measured the way the intake measures it: in BYTES, so a frame of multi-byte characters that
  // is under the cap by string length is still caught here rather than silently on the far side.
  const size = b4a.byteLength(str)
  if (maxBytes > 0 && size > maxBytes) {
    log.error('built an oversize', frame.type, 'frame:', size, 'bytes over a', maxBytes, 'cap — the receiver will drop it unparsed')
  }
  msgHandler.send(str)
}

async function sendIdentityFrame(socket, msgHandler, spaceId, topicHex, profile) {
  const profileKeyHex = b4a.toString(getProfileKey(), 'hex')
  const displayName = profile?.displayName || 'Unknown'
  const space = await getSpace(spaceId)
  const drive = getDrive(spaceId)
  if (drive) {
    const driveKeyHex = b4a.toString(drive.key, 'hex')
    // A v2 catalog is SCK-encrypted, so send its key in the …Enc field — the receiver reads the
    // field to decide whether to apply the SCK. A v1/plaintext key travels in the plain field.
    const loose = await ownLooseCatalogPublish(spaceId)
    const looseField = loose ? catalogKeyField(loose.keyHex, loose.encrypted, 'looseCatalogKey') : {}
    sendFrame(msgHandler, {
      type: PEER_FRAME.HANDSHAKE,
      profileKey: profileKeyHex,
      driveKey: driveKeyHex,
      displayName,
      spaceTopic: topicHex,
      ...looseField,
      // Carry our (bound) view of the member-set (OR-Set) root so connected members cross-check
      // it. A peer holding only a provisional pin confirms it from this; a divergent root surfaces.
      ...(space?.creatorKey ? { creator: space.creatorKey } : {}),
      ...(getLocalBinding(driveKeyHex) || {}),
    })
    announceLedger.recordSend(socket, spaceId, 'handshake', Date.now())
    return
  }
  // No local drive ⇒ a pending v2 join: announce a join request instead, echoing the
  // (single-use) auto-admit nonce from the invite so an auto-admit invite resolves.
  if (space?.status === 'pending') {
    sendFrame(msgHandler, {
      type: PEER_FRAME.MEMBERSHIP_REQUEST,
      profileKey: profileKeyHex,
      displayName,
      // Not avatarMaxBytes: this is the one frame carrying peer-supplied unbounded content, and it
      // is charged against peerFrameMaxBytes on the far side BEFORE it is parsed. An avatar sized
      // for storage would take the whole join request over that cap, and the request would be
      // dropped unread — no banner for the owner, no feedback for us, pending forever. Over budget
      // the joiner arrives with initials instead of a picture, which is what an avatar-less peer
      // already renders as.
      avatar: sanitizeAvatar(profile?.avatar, joinRequestAvatarMaxBytes()),
      spaceTopic: topicHex,
      inviteId: space.inviteId || null,
      ...(getLocalBinding() || {}),
    })
    announceLedger.recordSend(socket, spaceId, 'request', Date.now())
  }
}

export async function sendSingleHandshake(socket, msgHandler, spaceId, topicHex) {
  await sendIdentityFrame(socket, msgHandler, spaceId, topicHex, await getProfile())
}

// One profile read for the whole fan-out: every space announces the same identity, and a read
// per space is two bee gets per space.
export async function sendHandshakeMessages(socket, msgHandler) {
  log.debug('sending handshakes for', spaceTopics.size, 'spaces')
  const profile = await getProfile()
  for (const [spaceId, topic] of spaceTopics) {
    await sendIdentityFrame(socket, msgHandler, spaceId, topic, profile)
  }
}

export async function broadcastProfileUpdate() {
  if (socketMsgHandlers.size === 0) return
  log.info('broadcasting profile update to', socketMsgHandlers.size, 'peers')
  for (const [sock, msgHandler] of socketMsgHandlers) {
    await sendHandshakeMessages(sock, msgHandler)
  }
}

export function resetIdentityFrames() {
  localBindings.clear()
}
