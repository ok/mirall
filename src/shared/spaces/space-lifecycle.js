// How a space comes to exist for this peer: created here, joined from an invite, materialized
// when the creator's grant arrives, and the approval this peer hands to a joiner.
//
// Every space is SCK-encrypted, so one cannot exist without the master secret its key derives
// from. Production always holds one — main.js refuses to start when secure storage is
// unavailable — so the refusals below are invariants, not user-facing outcomes.
import crypto from 'hypercore-crypto'
import b4a from 'b4a'
import { hasMasterSecret, deriveSpaceContentKey } from '../core/store.js'
import { putContentKey } from './space-keys.js'
import { markApproval, clearRequest, getLocalPublicKeyHex } from './profile.js'
import { clearJoinRequest } from './join-requests.js'
import {
  getSpace,
  putSpaceRecord,
  mutateSpace,
  upsertMember,
} from './space.js'
import { announceParticipation, makeDriveSuffix, publishLooseCatalogKey, publishParticipationId } from './participation.js'

export async function createSpace(name, icon = 'folder') {
  const topicHex = b4a.toString(crypto.randomBytes(32), 'hex')
  const spaceId = topicHex.slice(0, 16)
  const driveSuffix = makeDriveSuffix()

  if (!hasMasterSecret()) throw new Error('createSpace: an identity is required to create a space')
  const sck = deriveSpaceContentKey(spaceId)
  await putContentKey(spaceId, sck)

  const space = {
    name,
    icon,
    topic: topicHex,
    created: new Date().toISOString(),
    members: [],
    driveSuffix,
    schemaVersion: 2,
    epoch: 0,
    createdBySelf: true,
    // The created-by-me marker an older release reads; nothing here reads it.
    sckDerivable: true,
    // creatorKey is the root of the membership OR-Set (conflict-free add/remove set)
    // fold. I created this space, so I am its root — stamp myself.
    creatorKey: getLocalPublicKeyHex(),
  }
  // Before the record: a failed profile write then leaves no half-created space behind.
  await publishParticipationId(spaceId, space)
  await putSpaceRecord(spaceId, space)
  // The catalog name derives from the SAVED record, so the loose-catalog key is published only
  // after the put — publishing earlier forks a divergent core.
  await publishLooseCatalogKey(spaceId, space)

  return { spaceId, ...space }
}

export async function joinSpace(topicHex, name = 'Unnamed Space', icon = 'folder', { inviteId, creator } = {}) {
  const spaceId = topicHex.slice(0, 16)

  const existing = await getSpace(spaceId)
  if (existing) {
    // A surviving durable `leaving` marker (an interrupted leave whose boot completion failed)
    // must not outlive a rejoin — boot would otherwise resume the leave and silently delete the
    // space the user just rejoined. Rejoining is the user's decision that the leave is off.
    if (existing.leaving) {
      await mutateSpace(spaceId, (space) => {
        const next = { ...space }
        delete next.leaving
        return next
      })
      delete existing.leaving
    }
    // The interrupted leave may already have retracted the id; re-publish it for this participation.
    await announceParticipation(spaceId, existing)
    return existing
  }

  if (!hasMasterSecret()) throw new Error('joinSpace: an identity is required to join a space')

  // Pending until the grant: nothing is announced before the space content key arrives.
  const space = {
    name,
    icon,
    topic: topicHex,
    created: new Date().toISOString(),
    members: [],
    driveSuffix: makeDriveSuffix(),
    schemaVersion: 2,
    epoch: 0,
    status: /** @type {'pending'} */ ('pending'),
    ...(inviteId ? { inviteId } : {}),
    // The invite's creator (envelope `c`) is an UNAUTHENTICATED bearer hint —
    // pre-seed it so the waiting view isn't empty, but mark it provisional. onGrant
    // authoritatively pins/corrects it from the authenticated SCK-grant before this space
    // ever folds a member set. Distinct from the pre-seeded inviter (`owner`): the fold
    // must seed from the creator, not whichever member's invite we joined through.
    ...(creator ? { creatorKey: creator, creatorUnverified: true } : {}),
  }
  await putSpaceRecord(spaceId, space)
  return { spaceId, ...space, pending: true }
}

// Store the granted key at the epoch the grant named, announce, then flip the space out of the
// pending state. The epoch lands first because the announce publishes it from the record; the flip
// lands last so a failed announce leaves the space pending, where the next grant retries it all.
export async function materializeSpace(spaceId, sck, { epoch = 0 } = {}) {
  await putContentKey(spaceId, sck, { epoch })
  const space = await mutateSpace(spaceId, (s) => ({ ...s, epoch }))
  if (!space) return null
  await publishParticipationId(spaceId, space)
  await publishLooseCatalogKey(spaceId, space)
  return await mutateSpace(spaceId, (s) => ({ ...s, status: 'approved' }))
}

export async function recordApproval(spaceId, joinerKey) {
  await markApproval(spaceId, joinerKey)
  await upsertMember(spaceId, { publicKey: joinerKey, status: 'approved' })
  await clearRequest(spaceId, joinerKey)
  clearJoinRequest(spaceId, joinerKey)
}
