import type { BadgeStatus, ShareRole } from './types.js'

export interface FolderStatusInput {
  role: ShareRole
  sourceMissing: boolean
  fault: boolean
  paused: boolean
  mirrorEnabled: boolean
  indexing: boolean
  mirrorSyncing: boolean
  // Our own presence view of the share's owner. Omitted means online.
  ownerOnline?: boolean
  // Proven short of the owner's listing. Omitted or false means unknown, never assumed.
  incomplete?: boolean
}

export interface FolderStatus {
  labelKey: string
  badge: BadgeStatus
}

export function deriveFolderStatus(input: FolderStatusInput): FolderStatus
