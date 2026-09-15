// When a mirror has outlived its share. A share missing from the owner's live list is usually a
// replication gap; only positive evidence that the owner left the space or deleted the share
// tears the orphaned mirror down.
import { createLogger } from '../core/logger.js'
import { getSpace } from '../spaces/space.js'
import { getLocalPublicKeyHex } from '../spaces/profile.js'
import { readPeerShareEntry } from '../shares/shares.js'
import { unmountForeignFolder } from './foreign-verbs.js'

const log = createLogger('foreign-orphan')

// A mount whose share is no longer in the owner's live list is usually just a transient
// replication gap — but the orphaned mirror must be torn down (stop the loop, drop the mount;
// materialized files stay on disk, matching owner-delete behaviour) once the owner is gone for good,
// in either of two ways: the owner LEFT the space (no longer in space.members — robust even when its
// tombstone never replicates, e.g. an offline leaver), or the owner DELETED the share (profile-bee
// tombstone). A genuinely-unreadable share whose owner is still a member is left alone to retry.
export async function maybeUnmountIfOwnerGone(mount) {
  if (await ownerLeftSpace(mount.spaceId, mount.ownerKey)) {
    log.info('owner left space — unmounting orphaned mirror', mount.shareId, '(files kept on disk)')
    await unmountForeignFolder(mount.spaceId, mount.shareId)
    return
  }
  const raw = await readPeerShareEntry(mount.ownerKey, mount.spaceId, mount.shareId)
  if (raw && raw.deletedAt) {
    log.info('owner removed share', mount.shareId, '— unmounting orphaned mirror (files kept on disk)')
    await unmountForeignFolder(mount.spaceId, mount.shareId)
  }
}

// Positive evidence only: true when we hold the space's member list and the owner is absent from it
// (left, or fold-dropped). Unknown/not-yet-loaded membership returns false so a boot/transient gap
// never triggers a spurious unmount.
async function ownerLeftSpace(spaceId, ownerKey) {
  // Our own share (self-mirror) — we never "leave" our own space; space.members lists OTHERS only.
  if (ownerKey === getLocalPublicKeyHex()) return false
  const space = await getSpace(spaceId)
  if (!space || !Array.isArray(space.members)) return false
  return !space.members.some((m) => m.publicKey === ownerKey)
}
