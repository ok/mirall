// The space projections the renderer reads. Rosters ship slim in spaces:list — avatars are
// base64 data-URLs up to the sanitizeAvatar cap, far too heavy for an every-refetch payload — so
// the full roster is a separate per-space read.

import { listSpaces, listPendingRequests } from '../shared/spaces/space.js'

// The self-first roster (avatars included) for ONE space. Rosters ship slim in spaces:list —
// avatars are base64 data-URLs up to the sanitizeAvatar cap, far too heavy for an
// every-refetch payload — so per-space consumers read this on demand.
export function fullRoster(space, profile) {
  const others = (space.members || []).filter((m) => !profile || m.publicKey !== profile.publicKey)
  if (!profile) return others
  const self = {
    publicKey: profile.publicKey,
    driveKey: null,
    displayName: profile.displayName,
    avatar: profile.avatar,
  }
  return [self, ...others]
}

// The catalog-key fields are worker-internal (handshake fallbacks) — no roster payload
// ships them to the renderer.
export function stripCatalogKeys({ looseCatalogKey, looseCatalogKeyEnc, ...m }) {
  return m
}

function slimMember(m) {
  const { avatar, ...slim } = stripCatalogKeys(m)
  return slim
}

// The one projection for every Space[] the worker ships (spaces:list AND the boot
// event:state) — slim self-first rosters plus memberCount/pendingCount. A second
// unprojected emit path would leak raw rosters and desync the renderer's Space type.
export async function slimSpaces(profile) {
  // A space mid-leave (or one whose interrupted-leave completion failed at boot) must not
  // surface as a normal space: it has no drive, no swarm, and is about to be forgotten.
  const allSpaces = (await listSpaces()).filter((s) => !s.leaving)
  return allSpaces.map(s => {
    const memberKeys = new Set((s.members || []).map(m => m.publicKey))
    if (profile) memberKeys.add(profile.publicKey)
    const members = fullRoster(s, profile).map(slimMember)
    return {
      ...s,
      members,
      memberCount: members.length,
      pendingCount: listPendingRequests(s.spaceId, memberKeys).length,
    }
  })
}
