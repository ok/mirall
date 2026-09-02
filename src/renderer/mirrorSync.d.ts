import type { ShareFileEntry } from './types.js'

export interface MirrorSyncSummary {
  active: boolean
  files: number
  onDevice: number
  bytesRemaining: number
  pct: number | null
  indeterminate: boolean
}

export function deriveMirrorSync(
  files: ShareFileEntry[],
  opts?: { truncated?: boolean; enabled?: boolean },
): MirrorSyncSummary
