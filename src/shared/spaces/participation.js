// This peer's participation in each space: the id its identity binding covers, and announcing that
// id with the loose-catalog key. The id derives from the master secret and the record's driveSuffix,
// so no core backs it; it travels as `driveKey` in the handshake and in the `drive/<spaceId>` profile
// row, the names earlier releases read it under.
import crypto from 'hypercore-crypto'
import b4a from 'b4a'
import { ownParticipationId } from '../core/store.js'
import { markSpaceDriveKey, markSpaceLooseCatalogKey, markSpaceLooseCatalogKeyEnc } from './profile.js'
import { ownLooseCatalogPublish } from '../shares/own-catalog.js'
import { createLogger } from '../core/logger.js'

const log = createLogger('participation')

export function makeDriveSuffix() {
  return b4a.toString(crypto.randomBytes(8), 'hex')
}

// A pending joiner participates once the grant materializes the space; until then it has no id to
// announce and no catalog to publish into. A space being left participates no longer.
export function isParticipating(space) {
  return !!space && space.status !== 'pending' && !space.leaving
}

export function getOwnParticipationId(spaceId, space) {
  return isParticipating(space) ? ownParticipationId(spaceId, space.driveSuffix) : null
}

// Requires the space RECORD to exist — the key derives from it through the catalog's name — so
// callers pass the record they already hold, which never publishes before the record is saved.
export async function publishLooseCatalogKey(spaceId, space) {
  if (!space) { log.warn('skipping loose-catalog key publish — no space record:', spaceId); return }
  const pub = await ownLooseCatalogPublish(spaceId, space)
  if (!pub) return
  try {
    if (pub.encrypted) await markSpaceLooseCatalogKeyEnc(spaceId, pub.keyHex, pub.epoch)
    else await markSpaceLooseCatalogKey(spaceId, pub.keyHex)
  } catch (err) { log.debug('loose-catalog key publish failed:', err.message) }
}

// Ungated by status, so create and grant can publish it before the record says the space is
// joined: a failure then leaves the space unjoined, and the step retries with the next attempt.
export async function publishParticipationId(spaceId, space) {
  await markSpaceDriveKey(spaceId, ownParticipationId(spaceId, space.driveSuffix))
}

// Tell co-members who derive us from records alone how to know us and read our content. Both writes
// are idempotent, so boot and a rejoin repeat them for every space we participate in.
export async function announceParticipation(spaceId, space) {
  if (!isParticipating(space)) return
  await publishParticipationId(spaceId, space)
  await publishLooseCatalogKey(spaceId, space)
}
