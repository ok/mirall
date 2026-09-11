// Literal tuples, not string[]: the renderer derives its unions from these with (typeof X)[number],
// so a widened declaration would silently turn an exhaustive switch into `string`.
// Generated from statuses.js — contract-declarations.test.js asserts the two agree.
export declare const FILE_STATUS: Readonly<{ MINE: 'mine'; DOWNLOADED: 'downloaded'; REMOTE: 'remote'; PREPARING: 'preparing'; DOWNLOADING: 'downloading'; VERIFYING: 'verifying'; PUBLISHING: 'publishing'; PAUSED_INTERRUPTED: 'paused-interrupted'; PAUSED_OFFLINE: 'paused-offline'; UNAVAILABLE: 'unavailable'; ERROR: 'error' }>
export declare const BADGE_STATUS: Readonly<{ MINE: 'mine'; ON_DEVICE: 'on-device'; AVAILABLE: 'available'; DOWNLOADING: 'downloading'; VERIFYING: 'verifying'; PREPARING: 'preparing'; PUBLISHING: 'publishing'; PAUSED: 'paused'; OWNER_OFFLINE: 'owner-offline'; UNAVAILABLE: 'unavailable'; ERROR: 'error' }>
export declare const SHARE_FILE_STATUS: Readonly<{ REMOTE: 'remote'; PREPARING: 'preparing'; DOWNLOADING: 'downloading'; VERIFYING: 'verifying'; PUBLISHING: 'publishing'; DOWNLOADED: 'downloaded'; SYNCED: 'synced'; UNAVAILABLE: 'unavailable'; PAUSED_INTERRUPTED: 'paused-interrupted'; PAUSED_OFFLINE: 'paused-offline'; ERROR: 'error' }>
export declare const MOUNT_STATUS: Readonly<{ IDLE: 'idle'; SCANNING: 'scanning'; ACTIVE: 'active'; PAUSED: 'paused'; PAUSED_ENOSPC: 'paused-enospc'; PAUSED_ERROR: 'paused-error'; MOUNT_POINT_GONE: 'mount-point-gone' }>
export declare const MIRROR_STATE: Readonly<{ SYNCING: 'syncing'; SYNCED: 'synced'; PAUSED: 'paused' }>
export declare const FILE_STATUSES: readonly ['mine', 'downloaded', 'remote', 'preparing', 'downloading', 'verifying', 'publishing', 'paused-interrupted', 'paused-offline', 'unavailable', 'error']
export declare const BADGE_STATUSES: readonly ['mine', 'on-device', 'available', 'downloading', 'verifying', 'preparing', 'publishing', 'paused', 'owner-offline', 'unavailable', 'error']
export declare const SHARE_FILE_STATUSES: readonly ['remote', 'preparing', 'downloading', 'verifying', 'publishing', 'downloaded', 'synced', 'unavailable', 'paused-interrupted', 'paused-offline', 'error']
export declare const OWNED_MOUNT_STATUSES: readonly ['scanning', 'active', 'paused', 'paused-enospc', 'paused-error', 'mount-point-gone']
export declare const FOREIGN_MOUNT_STATUSES: readonly ['idle', 'scanning', 'active', 'paused', 'paused-enospc', 'paused-error', 'mount-point-gone']
export declare const MIRROR_STATES: readonly ['syncing', 'synced', 'paused']
export declare const ON_DEVICE_STATUSES: readonly ['downloaded', 'synced']
export declare const HEALTHY_OWNED_STATUSES: readonly ['active', 'scanning']
