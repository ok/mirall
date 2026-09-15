// The share record behind a mirror: the owner's entry, stamped with the space and owner the mount
// names, or null while the owner's profile has not replicated or the share is gone.
import { readPeerShares } from '../shares/shares.js'

export async function loadShareForForeignMount(mount) {
  const shares = await readPeerShares(mount.ownerKey, mount.spaceId)
  if (!shares) return null
  const found = shares.find((s) => s.id === mount.shareId)
  if (!found) return null
  return { ...found, spaceId: mount.spaceId, owner: mount.ownerKey }
}
