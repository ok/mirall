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
import { markApproval, clearRequest, markSpaceDriveKey, getLocalPublicKeyHex } from './profile.js'
import { clearJoinRequest } from './join-requests.js'
import {
  getSpace,
  putSpaceRecord,
  mutateSpace,
  upsertMember,
  getSpaceContentKey,
} from './space.js'
import {
  getDrive,
  openOwnDrive,
  announceOwnDrive,
  publishLooseCatalogKey,
  makeDriveSuffix,
} from './space-drives.js'

export async function createSpace(name, icon = 'folder') {
  const topicHex = b4a.toString(crypto.randomBytes(32), 'hex')
  const spaceId = topicHex.slice(0, 16)
  const driveSuffix = makeDriveSuffix()

  if (!hasMasterSecret()) throw new Error('createSpace: an identity is required to create a space')
  const sck = deriveSpaceContentKey(spaceId)
  await putContentKey(spaceId, sck)

  const drive = await openOwnDrive(spaceId, driveSuffix, sck)
  const driveKey = b4a.toString(drive.key, 'hex')
  await markSpaceDriveKey(spaceId, driveKey)

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
  await putSpaceRecord(spaceId, space)
  // The catalog name derives from the SAVED record, so the loose-catalog key is published only
  // after the put — publishing earlier forks a divergent core.
  await publishLooseCatalogKey(spaceId, space)

  return { spaceId, ...space, driveKey }
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
    return rejoinDrive(existing)
  }

  if (!hasMasterSecret()) throw new Error('joinSpace: an identity is required to join a space')

  // Stay pending and DON'T create the writable drive yet — it must be encrypted from block 0
  // once the granted SCK arrives (hypercore can't retro-encrypt). materializeOwnDrive creates
  // it on grant.
  const space = {
    name,
    icon,
    topic: topicHex,
    created: new Date().toISOString(),
    members: [],
    driveSuffix: makeDriveSuffix(),
    schemaVersion: 2,
    epoch: 0,
    status: 'pending',
    ...(inviteId ? { inviteId } : {}),
    // The invite's creator (envelope `c`) is an UNAUTHENTICATED bearer hint —
    // pre-seed it so the waiting view isn't empty, but mark it provisional. onGrant
    // authoritatively pins/corrects it from the authenticated SCK-grant before this space
    // ever folds a member set. Distinct from the pre-seeded inviter (`owner`): the fold
    // must seed from the creator, not whichever member's invite we joined through.
    ...(creator ? { creatorKey: creator, creatorUnverified: true } : {}),
  }
  await putSpaceRecord(spaceId, space)
  return { spaceId, ...space, driveKey: null, pending: true }
}

async function rejoinDrive(space) {
  if (space.status !== 'pending' && !getDrive(space.spaceId)) {
    await openOwnDrive(space.spaceId, space.driveSuffix, getSpaceContentKey(space.spaceId, space))
  }
  return space
}

// Create our own writable space drive, encrypted from block 0 with the granted SCK, and flip
// the space out of the pending state at the epoch the grant named.
export async function materializeOwnDrive(spaceId, sck, { epoch = 0 } = {}) {
  await putContentKey(spaceId, sck, { epoch })
  // The epoch lands on the record before the announce, which publishes it from the record.
  const space = await mutateSpace(spaceId, (s) => ({ ...s, epoch }))
  if (!space) return null
  const drive = getDrive(spaceId) || await openOwnDrive(spaceId, space.driveSuffix, sck)
  await announceOwnDrive(spaceId, space, drive)
  await mutateSpace(spaceId, (s) => ({ ...s, status: 'approved' }))
  return drive
}

export async function recordApproval(spaceId, joinerKey) {
  await markApproval(spaceId, joinerKey)
  await upsertMember(spaceId, { publicKey: joinerKey, status: 'approved' })
  await clearRequest(spaceId, joinerKey)
  clearJoinRequest(spaceId, joinerKey)
}
