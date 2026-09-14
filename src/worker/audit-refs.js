// Audit rows must render with zero joins: a space record is deleted on leave and a peer's name
// needs that peer reachable, so both are snapshotted into the row at write time. These adapters
// are the single place that resolution happens, and the reason they live in the worker rather than
// beside the builders is that each one reaches live worker state the contract layer cannot see.

import { getConnectedMemberMeta } from '../shared/network/swarm.js'
import { displayNameOrNull } from '../shared/spaces/membership/fold.js'
import { listSharesForSpace } from '../shared/shares/share-registry.js'
import { getLocalPublicKeyHex } from '../shared/spaces/profile.js'
import { setAuditIdentity } from '../shared/audit/audit-log.js'
import { peerActor, spaceRef } from '../shared/audit/audit-record.js'

export function refreshAuditSelfName(displayName) {
  setAuditIdentity({ key: getLocalPublicKeyHex(), name: displayName })
}

// Resolves the name, which needs the live roster and the persisted members — the two things
// audit-record.js deliberately cannot reach. The shape itself comes from peerActor.
export function peerActorIn(space, publicKey) {
  const live = space ? getConnectedMemberMeta(space.spaceId, publicKey) : null
  const persisted = (space?.members || []).find((m) => m.publicKey === publicKey)
  return peerActor(publicKey, displayNameOrNull(live?.displayName) || displayNameOrNull(persisted?.displayName) || null)
}

// The worker holds space RECORDS, whose id field is `spaceId`; every other producer holds the id
// and the name separately. One adapter, rather than a second shape in the shared builder.
export function spaceRefOf(space) {
  return spaceRef(space?.spaceId, space?.name)
}

export function fileNameOf(path) {
  if (typeof path !== 'string') return null
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return i >= 0 ? path.slice(i + 1) : path
}

export async function shareNameOrNull(spaceId, ownerKey, shareId) {
  try {
    const all = await listSharesForSpace(spaceId)
    return all.find((s) => s.id === shareId && s.owner === ownerKey)?.name ?? null
  } catch {
    return null
  }
}
