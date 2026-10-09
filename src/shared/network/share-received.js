// share-received: a member tells a file's owner it now holds a verified copy, so the owner can show
// who has the file once the live download indicator is gone. Unicast to the owner over the control
// channel. A notice the owner cannot take right now waits in a bounded per-owner outbox until the
// owner's next handshake; the outbox is in memory, so a restart before that drops it. Which notices
// the owner accepts is share-received-intake.js.
import b4a from 'b4a'
import { PEER_FRAME } from '../contract/peer-frames.js'
import { getProfileKey } from '../spaces/profile.js'
import { getOwnEntry } from '../shares/own-catalog.js'
import { createLogger } from '../core/logger.js'
import { noteFileRecipient } from '../transfer/file-recipients.js'
import { connectedPeers, safeSend, authorizedOn } from './swarm-registries.js'
import { createShareReceivedIntake, SHARE_RECEIVED_VERDICT } from './share-received-intake.js'

const log = createLogger('share-received')

const OUTBOX_PER_OWNER = 200
// ownerKey → Map<spaceId\0shareId\0relPath, payload>; a newer copy of the same file replaces the older.
const outbox = new Map()

function trySend(ownerKey, payload) {
  const peer = connectedPeers.get(ownerKey)
  if (!peer?.spaces.has(payload.spaceId)) return false
  const self = getProfileKey()
  if (!self) return false
  return safeSend(peer, JSON.stringify({ type: PEER_FRAME.SHARE_RECEIVED, profileKey: b4a.toString(self, 'hex'), ...payload }))
}

function enqueue(ownerKey, payload) {
  let queued = outbox.get(ownerKey)
  if (!queued) outbox.set(ownerKey, (queued = new Map()))
  const key = [payload.spaceId, payload.shareId, payload.relPath].join('\0')
  queued.delete(key)
  queued.set(key, payload)
  if (queued.size > OUTBOX_PER_OWNER) queued.delete(queued.keys().next().value)
}

/** @param {string} ownerKey @param {{ spaceId: string, shareId: string, relPath: string, contentHash: string }} payload */
export function announceShareReceived(ownerKey, payload) {
  if (!trySend(ownerKey, payload)) enqueue(ownerKey, payload)
}

/** @param {string} ownerKey */
export function flushShareReceived(ownerKey) {
  const queued = outbox.get(ownerKey)
  if (!queued) return
  for (const [key, payload] of queued) if (trySend(ownerKey, payload)) queued.delete(key)
  if (queued.size === 0) outbox.delete(ownerKey)
}

const intake = createShareReceivedIntake({
  authorizedOn,
  inSpace: (profileKey, spaceId) => !!connectedPeers.get(profileKey)?.spaces.has(spaceId),
  ownEntry: getOwnEntry,
  noteRecipient: noteFileRecipient,
})

// debug, not warn: any peer on the topic can send one, and a louder level would hand it a log-spam
// primitive.
export function handleShareReceivedFrame(socket, msg) {
  return intake.handle(socket, msg).then((verdict) => {
    if (verdict !== SHARE_RECEIVED_VERDICT.RECORDED) log.debug('share-received dropped:', verdict)
  }, (err) => log.debug('share-received handling failed:', err?.message || err))
}

export function resetShareReceived() {
  outbox.clear()
}
