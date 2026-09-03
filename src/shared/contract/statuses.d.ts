// Literal tuples, not string[]: the renderer derives its unions from these with (typeof X)[number],
// so a widened declaration would silently turn an exhaustive switch into `string`.
// Generated from statuses.js — contract-declarations.test.js asserts the two agree.
export declare const FILE_STATUS: readonly ['mine', 'downloaded', 'remote', 'preparing', 'downloading', 'verifying', 'publishing', 'paused-interrupted', 'paused-offline', 'unavailable', 'error']
export declare const BADGE_STATUS: readonly ['mine', 'on-device', 'available', 'downloading', 'verifying', 'preparing', 'publishing', 'paused', 'owner-offline', 'unavailable', 'error']
export declare const SHARE_FILE_STATUS: readonly ['remote', 'preparing', 'downloading', 'verifying', 'publishing', 'downloaded', 'synced', 'unavailable', 'paused-interrupted', 'paused-offline', 'error']
export declare const OWNED_MOUNT_STATUS: readonly ['scanning', 'active', 'paused', 'paused-enospc', 'paused-error', 'mount-point-gone']
export declare const FOREIGN_MOUNT_STATUS: readonly ['idle', 'scanning', 'active', 'paused', 'paused-enospc', 'paused-error', 'mount-point-gone']
