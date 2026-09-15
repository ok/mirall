// What the owner side remembers about a share between passes: the share records a pass resolves
// against, the worst I/O fault seen since the last one settled, and the shares whose pass the
// supervisor abandoned. Each outlives the pass that filled it, which is why none of it lives in
// the pass itself.
import { classifyLocalIoFault } from '../core/errors.js'
import { ownedKey, worsePassFault } from './owned-policy.js'

export function createOwnedState() {
  const shares = new Map()
  const faults = new Map()
  const units = new Map()
  const abandoned = new Set()

  return {
    // The ids behind a supervisor key, remembered when a pass starts so recover() never has to
    // parse one back out: a share id is opaque and splitting it would be a guess.
    remember(spaceId, shareId) {
      units.set(ownedKey(spaceId, shareId), { spaceId, shareId })
    },
    unit(key) {
      return units.get(key) ?? null
    },
    forget(key) {
      units.delete(key)
      abandoned.delete(key)
    },

    cachedShare(spaceId, shareId) {
      return shares.get(ownedKey(spaceId, shareId)) ?? null
    },
    cacheShare(spaceId, shareId, share) {
      shares.set(ownedKey(spaceId, shareId), share)
    },
    // Dropped per space, because that is the boundary the publish lane goes idle on.
    forgetShares(spaceId) {
      for (const key of [...shares.keys()]) if (key.startsWith(spaceId + ':')) shares.delete(key)
    },

    // Never cleared when a pass starts, only when one settles: a watcher item that failed between
    // passes is the live case, and clearing at the start would throw exactly that away.
    recordFault(spaceId, shareId, err) {
      const code = classifyLocalIoFault(err)
      if (!code) return
      const key = ownedKey(spaceId, shareId)
      faults.set(key, worsePassFault(faults.get(key) ?? null, code))
    },
    takeFault(spaceId, shareId) {
      const key = ownedKey(spaceId, shareId)
      const code = faults.get(key) ?? null
      faults.delete(key)
      return code
    },

    // Kept reported: the policy prunes the strike counter of any row nobody reports, so a unit
    // that vanished the moment we acted on it could never reach `maxRecoveries` or be given up on
    // by name.
    abandon(key) {
      abandoned.add(key)
    },
    unabandon(key) {
      abandoned.delete(key)
    },
    abandonedKeys() {
      return [...abandoned]
    },

    reset() {
      shares.clear()
      faults.clear()
      units.clear()
      abandoned.clear()
    },
  }
}
