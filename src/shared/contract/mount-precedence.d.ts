// Generated from mount-precedence.js — contract-declarations.test.js asserts the two agree.
import type { OWNED_MOUNT_STATUSES } from './statuses.js'

export type OwnedMountStatusValue = (typeof OWNED_MOUNT_STATUSES)[number]

export interface OwnedMountFacts {
  status?: string | null
  indexPaused?: boolean
  mountPointMissing?: boolean
}

export declare function isFaultStatus(status: string | null | undefined): boolean
export declare function ownedMountStatus(record: OwnedMountFacts | null | undefined): OwnedMountStatusValue | null
export declare function isHealthyOwnedStatus(status: string | null | undefined): boolean
export declare const _rankForTests: Readonly<Record<string, number>>
