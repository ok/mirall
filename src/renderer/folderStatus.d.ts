import type { BadgeStatus, ShareRole } from './types.js'

export interface FolderStatusInput {
  role: ShareRole
  sourceMissing: boolean
  indexPaused: boolean
  mirrorEnabled: boolean
  indexing: boolean
  mirrorSyncing: boolean
}

export interface FolderStatus {
  labelKey: string
  badge: BadgeStatus
}

export function deriveFolderStatus(input: FolderStatusInput): FolderStatus
