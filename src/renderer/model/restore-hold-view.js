// What the app may do while a restore is being confirmed, from the worker's restore status. Pure, so the
// rules are the same wherever a control asks. A held profile blocks every profile write; a space whose
// own catalog is held blocks sharing in that space. The worker refuses the same writes (restore-guard.js).

import { RESTORE_VERDICT } from '../../shared/contract/restore-verdict.js'

/** @import { RestoreStatus } from '../../shared/contract/responses.js' */
/** @typedef {{ active: boolean, source: 'backup' | 'key' | null, progress: RestoreStatus['profile'], heldSpaceIds: string[], canWriteProfile: boolean, canShareIn: (spaceId: string) => boolean }} RestoreHoldView */

/** @param {RestoreStatus | null} restore @returns {RestoreHoldView} */
export function restoreHoldView(restore) {
  const progress = restore?.profile ?? null
  // Released but not yet restarted still refuses in the worker, for the seconds the restart takes.
  const profileHeld = progress !== null
  const held = new Set(restore?.heldSpaceIds ?? [])
  return {
    active: profileHeld,
    source: restore?.source ?? null,
    progress,
    heldSpaceIds: [...held],
    canWriteProfile: !profileHeld,
    canShareIn: (spaceId) => !profileHeld && !held.has(spaceId),
  }
}

/** @param {RestoreHoldView} view @returns {{ lead: string, detail: string, waiting: boolean }} */
export function restoreBannerCopy(view) {
  const key = view.source === 'key'
  return {
    lead: key ? 'restore.bannerKeyLead' : 'restore.bannerBackupLead',
    detail: key ? 'restore.bannerKeyDetail' : 'restore.bannerBackupDetail',
    waiting: view.progress?.verdict === RESTORE_VERDICT.NO_HOLDER && !view.progress.released,
  }
}
