// Status → badge lookup tables: every transfer status the worker reports maps
// to a badge style (Tailwind classes) plus an i18n label key, for both loose
// file rows and share/folder rows, and share role badges (mine / browse /
// mirrored). Pure data + lookups so the mapping is unit-testable.
/** @import { BadgeStatus, FileStatus, ShareFileStatus, ShareRole } from '../types/types.js' */
/** @typedef {{ classes: string, labelKey: string }} BadgeAppearance */

/** @type {Readonly<Record<BadgeStatus, BadgeAppearance>>} */
const STYLES = {
  mine: { classes: 'bg-success text-accent', labelKey: 'status.mine' },
  'on-device': { classes: 'bg-success text-accent', labelKey: 'status.downloaded' },
  modified: { classes: 'bg-warning text-on-warning', labelKey: 'status.modified' },
  available: { classes: 'bg-surface-container-highest text-accent', labelKey: 'status.remote' },
  downloading: { classes: 'bg-info text-accent', labelKey: 'status.downloading' },
  verifying: { classes: 'bg-info text-accent animate-pulse', labelKey: 'status.verifying' },
  preparing: { classes: 'bg-info text-accent animate-pulse', labelKey: 'status.preparing' },
  publishing: { classes: 'bg-info text-accent', labelKey: 'status.publishing' },
  paused: { classes: 'bg-warning text-on-warning', labelKey: 'status.pausedInterrupted' },
  'owner-offline': { classes: 'bg-surface-container-highest text-accent', labelKey: 'status.ownerOffline' },
  unavailable: { classes: 'bg-surface-container-highest text-accent', labelKey: 'status.unavailable' },
  error: { classes: 'bg-error-container text-accent', labelKey: 'status.failed' },
}

/** @type {Readonly<Record<FileStatus, BadgeStatus>>} */
const FILE_STATUS_TO_BADGE = {
  mine: 'mine',
  downloaded: 'on-device',
  modified: 'modified',
  remote: 'available',
  preparing: 'preparing',
  downloading: 'downloading',
  verifying: 'verifying',
  publishing: 'publishing',
  'paused-interrupted': 'paused',
  'paused-offline': 'owner-offline',
  unavailable: 'unavailable',
  error: 'error',
}

/** @type {Readonly<Record<ShareFileStatus, BadgeStatus>>} */
const SHARE_FILE_STATUS_TO_BADGE = {
  remote: 'available',
  preparing: 'preparing',
  downloading: 'downloading',
  verifying: 'verifying',
  publishing: 'publishing',
  downloaded: 'on-device',
  synced: 'on-device',
  modified: 'modified',
  unavailable: 'unavailable',
  'paused-interrupted': 'paused',
  'paused-offline': 'owner-offline',
  error: 'error',
}

/** @type {Readonly<Record<ShareRole, BadgeAppearance>>} */
const ROLE_STYLES = {
  mine: { classes: 'bg-surface-container-highest text-accent', labelKey: 'share.badgeMine' },
  browse: { classes: 'bg-surface-container-highest text-accent', labelKey: 'share.badgeBrowse' },
  mirrored: { classes: 'bg-surface-container-highest text-accent', labelKey: 'share.badgeMirrored' },
}

/** @param {FileStatus} status */
export function fileStatusToBadge(status) {
  return FILE_STATUS_TO_BADGE[status]
}

/** @param {ShareFileStatus} status @param {boolean} isOwn @returns {BadgeStatus} */
export function shareFileStatusToBadge(status, isOwn) {
  if (isOwn && status === 'synced') return 'mine'
  return SHARE_FILE_STATUS_TO_BADGE[status]
}

/** @param {BadgeStatus} badgeStatus */
export function badgeStyle(badgeStatus) {
  return STYLES[badgeStatus]
}

/** @param {ShareRole} role @param {{ paused?: boolean, missing?: boolean, fault?: boolean }} [opts] @returns {BadgeAppearance} */
export function roleBadge(role, opts) {
  if (opts && opts.missing) return { classes: STYLES.paused.classes, labelKey: 'share.mountPointGone' }
  // Above the pause: an auto-paused mirror is paused AND faulted, and "Paused" is the half that
  // makes it look like the user's own doing.
  if (opts && opts.fault) return { classes: STYLES.error.classes, labelKey: 'folder.statusFault' }
  if (opts && opts.paused) return { classes: STYLES.paused.classes, labelKey: 'folder.paused' }
  return ROLE_STYLES[role] ?? ROLE_STYLES.browse
}
