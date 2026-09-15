// How the owner side resolves the share record behind a mount. The diff reads it fresh every pass;
// the publish channel reads it once per item and caches, because a bulk pass resolves thousands.
import { AppError } from '../core/errors.js'
import { CODES } from '../contract/errors.js'
import { readOwnShares } from '../shares/shares.js'

export async function loadShareForMount(mount) {
  const own = await readOwnShares(mount.spaceId)
  const share = own.find((s) => s.id === mount.shareId)
  if (!share) throw new AppError(CODES.NOT_FOUND, 'Share missing for mount')
  return { ...share, spaceId: mount.spaceId }
}

// Null rather than a throw: the channel treats an unresolvable share as a skip, and an item whose
// share has gone is not a failure to report.
export async function loadShare(state, spaceId, shareId) {
  const cached = state.cachedShare(spaceId, shareId)
  if (cached) return cached
  let share = null
  try {
    share = await loadShareForMount({ spaceId, shareId })
  } catch {
    return null
  }
  state.cacheShare(spaceId, shareId, share)
  return share
}
