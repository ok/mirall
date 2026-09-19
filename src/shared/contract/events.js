// Every event the worker pushes to the renderer. Emitted names are the source of truth. The
// renderer imports EventName, so a mistyped subscribe() fails tsc; the worker's
// emit sites are plain .js that no compiler reads, so they are policed instead by
// test/unit/contract-declarations.test.js, which parses every emit site, every renderer
// subscription and this list and asserts all three name the same set.
const EVENTS = Object.freeze({
  AUDIT_UPDATED: 'event:audit-updated',
  AWARENESS: 'event:awareness',
  DECORATION: 'event:decoration',
  DOWNLOAD_ROOTS_STATUS: 'event:download-roots-status',
  FILES_UPDATED: 'event:files-updated',
  FOREIGN_FOLDER_MOUNT_STATUS: 'event:foreign-folder-mount-status',
  FOREIGN_FOLDER_PREVIEW_PROGRESS: 'event:foreign-folder-preview-progress',
  JOIN_REQUESTS_UPDATED: 'event:join-requests-updated',
  LEAVE_PROGRESS: 'event:leave-progress',
  MEMBER_AVATAR_UPDATED: 'event:member-avatar-updated',
  MEMBER_JOIN_REQUEST: 'event:member-join-request',
  MEMBER_JOINED: 'event:member-joined',
  MEMBER_LEFT: 'event:member-left',
  MEMBERS_UPDATED: 'event:members-updated',
  MEMBERSHIP_CREATOR_DIVERGENCE: 'event:membership-creator-divergence',
  MEMBERSHIP_DENIED: 'event:membership-denied',
  MEMBERSHIP_GRANTED: 'event:membership-granted',
  MIRRORS_UPDATED: 'event:mirrors-updated',
  NETWORK_STATUS: 'event:network-status',
  OWNED_FOLDER_INDEX_PROGRESS: 'event:owned-folder-index-progress',
  OWNED_FOLDER_MOUNT_STATUS: 'event:owned-folder-mount-status',
  OWNED_FOLDER_PREVIEW_PROGRESS: 'event:owned-folder-preview-progress',
  OWNED_FOLDER_SCAN_COMPLETED: 'event:owned-folder-scan-completed',
  PROFILE_NEEDED: 'event:profile-needed',
  RECONCILE: 'event:reconcile',
  SHARE_FILES_UPDATED: 'event:share-files-updated',
  SHARE_INDEX_PROGRESS: 'event:share-index-progress',
  SHARES_UPDATED: 'event:shares-updated',
  STATE: 'event:state',
  TRANSFER_COMPLETE: 'event:transfer-complete',
  TRANSFER_ERROR: 'event:transfer-error',
  TRANSFER_PAUSED: 'event:transfer-paused',
  TRANSFER_REMOVED: 'event:transfer-removed',
  TRANSFER_SUPERSEDED: 'event:transfer-superseded',
  WORKER_READY: 'event:worker-ready',
})

/** @internal the declaration-parity guards' list; EventName below is the production reader */
export const EVENT_NAMES = Object.freeze(Object.values(EVENTS))
/** @typedef {(typeof EVENT_NAMES)[number]} EventName */

// Events that belong to ONE caller's operation rather than to the space. Broadcasting these leaks
// one client's progress into another's UI — and for leave-progress it is indistinguishable from
// the recipient's own leave. The router refuses to broadcast them; they are emitted with
// { to: client }, and test/invariants/targeted-events.test.js pins that every call site does.
/** @internal the routing guard's list */
export const TARGETED_EVENTS = Object.freeze([
  'event:owned-folder-preview-progress',
  'event:foreign-folder-preview-progress',
  'event:leave-progress',
])
