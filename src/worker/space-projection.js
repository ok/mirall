// The space projections the renderer reads. Rosters ship slim in spaces:list — avatars are
// base64 data-URLs up to the sanitizeAvatar cap, far too heavy for an every-refetch payload — so
// the full roster is a separate per-space read.

import { listSpaces } from '../shared/spaces/space.js'
import { listPendingRequests } from '../shared/spaces/join-requests.js'
import { verifiedMembers } from '../shared/spaces/member-standing.js'
import { lastActivityOf } from '../shared/audit/space-activity.js'

// The self-first roster (avatars included) for ONE space. Rosters ship slim in spaces:list —
// avatars are base64 data-URLs up to the sanitizeAvatar cap, far too heavy for an
// every-refetch payload — so per-space consumers read this on demand.
export function fullRoster(space, profile) {
  const others = (space.members || []).filter((m) => !profile || m.publicKey !== profile.personKey)
  if (!profile) return others
  const self = {
    publicKey: profile.personKey,
    displayName: profile.displayName,
    avatar: profile.avatar,
  }
  return [self, ...others]
}

// The catalog-key fields are worker-internal (handshake fallbacks), and a member record written by an
// earlier release may still carry its participation id — no roster payload ships either.
export function stripWorkerFields({ driveKey, looseCatalogKey, looseCatalogKeyEnc, looseCatalogEpoch, ...m }) {
  return m
}

function slimMember(m) {
  const { avatar, ...slim } = stripWorkerFields(m)
  return slim
}

// A space with no activity seen yet counts from when this device created or joined it.
export function lastActivity(space) {
  const created = Date.parse(space.created) || 0
  return Math.max(lastActivityOf(space.spaceId) ?? 0, created)
}

// The spaces list's order: the most recently active first, a tie by name.
/** @param {{ lastActivity: number, name: string }} a @param {{ lastActivity: number, name: string }} b */
export function byLastActivity(a, b) {
  return b.lastActivity - a.lastActivity || a.name.localeCompare(b.name)
}

// The one projection for every Space[] the worker ships (spaces:list AND the boot
// event:state) — slim self-first rosters plus memberCount/pendingCount, the most recently
// active first. A second unprojected emit path would leak raw rosters and desync the
// renderer's Space type.
export async function slimSpaces(profile) {
  // A space mid-leave (or one whose interrupted-leave completion failed at boot) must not
  // surface as a normal space: it has no swarm and is about to be forgotten.
  const allSpaces = (await listSpaces()).filter((s) => !s.leaving)
  const spaces = allSpaces.map(s => {
    const memberKeys = new Set(verifiedMembers(s.members).map(m => m.publicKey))
    if (profile) memberKeys.add(profile.personKey)
    const members = fullRoster(s, profile).map(slimMember)
    return {
      ...s,
      members,
      memberCount: members.length,
      pendingCount: listPendingRequests(s.spaceId, memberKeys).length,
      lastActivity: lastActivity(s),
    }
  })
  return spaces.sort(byLastActivity)
}
