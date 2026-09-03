import type { BadgeStatus, FileStatus, ShareFileStatus, ShareRole } from './types.js'

export interface BadgeAppearance {
  classes: string
  labelKey: string
}

export function fileStatusToBadge(status: FileStatus): BadgeStatus
export function shareFileStatusToBadge(status: ShareFileStatus, isOwn: boolean): BadgeStatus
export function badgeStyle(badgeStatus: BadgeStatus): BadgeAppearance
export function roleBadge(role: ShareRole, opts?: { paused?: boolean; missing?: boolean; fault?: boolean }): BadgeAppearance
