import type { ShareRole } from './types.js'

export interface FolderCommandsInput {
  role: ShareRole
  // Syncing is currently held: the owner's paused index, or a mirror switched off.
  paused: boolean
  sourceMissing: boolean
  // The screen can hand the mirror act somewhere; without it the entry has nowhere to go.
  canMirror: boolean
}

export interface FolderCommandSpec {
  labelKey: string
  available: boolean
}

export interface FolderCommands {
  open: FolderCommandSpec
  locate: FolderCommandSpec
  toggleSync: FolderCommandSpec
  mirror: FolderCommandSpec
  edit: FolderCommandSpec
}

export function deriveFolderCommands(input: FolderCommandsInput): FolderCommands
