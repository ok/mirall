// A restored profile or catalog is read-only until co-members confirm nothing newer exists
// (restore-hold-rules.js). A request that would write one is refused before it changes anything, with
// one code the app explains, rather than failing half-way inside the write.
import { AppError } from './errors.js'
import { CODES } from '../contract/errors.js'
import { profileHeld, isHeld } from './restore-hold.js'
import { getSpace } from '../spaces/space.js'
import { catalogNameForSpace } from '../shares/own-catalog.js'

export function assertProfileWritable() {
  if (profileHeld()) throw new AppError(CODES.RESTORE_HELD, 'restore: your profile is being confirmed with your spaces')
}

/** @param {string} spaceId */
export async function assertCatalogWritable(spaceId) {
  const space = await getSpace(spaceId)
  if (space && isHeld(catalogNameForSpace(spaceId, space))) {
    throw new AppError(CODES.RESTORE_HELD, 'restore: this space is being confirmed with its members')
  }
}
