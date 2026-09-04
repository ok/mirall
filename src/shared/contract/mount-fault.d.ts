// Generated from mount-fault.js — contract-declarations.test.js asserts the two agree.
export type MountFaultStatus = 'paused-enospc' | 'paused-error'
export type AutoPauseStatus = 'mount-point-gone' | 'paused-enospc' | 'paused-error'

export interface MountFault {
  status: string
  code: string | null
}

export declare const STATUS_MOUNT_GONE: 'mount-point-gone'
export declare const AUTO_PAUSE_STATUSES: readonly ['mount-point-gone', 'paused-enospc', 'paused-error']
export declare function statusForFaultCode(code: string | null | undefined): MountFaultStatus
export declare function isAutoPauseStatus(status: string | null | undefined): boolean
export declare function isMountFault(status: string | null | undefined): boolean
export declare function mountFault(status: string | null | undefined, lastError?: string | null): MountFault | null
