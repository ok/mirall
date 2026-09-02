import type { IconName } from './components/primitives/Icon.js'
import type { ShareRole } from './types.js'

export type StripId = 'source-missing' | 'paused' | 'working' | 'peer-indexing' | 'owner-offline' | 'over-limit'
export type StripTone = 'error' | 'warning' | 'info' | 'neutral'
export type StripAction = 'locate' | 'resume' | 'pause' | null

export interface StripData {
  kind?: 'indexing' | 'mirroring' | 'peer-indexing'
  role?: ShareRole
  scanning?: boolean
  files?: number
  bytes?: number
  indeterminate?: boolean
  pct?: number | null
  shown?: number
  total?: number
  limit?: number
}

export interface FolderStrip {
  id: StripId
  tone: StripTone
  icon: IconName
  live: 'status' | 'alert' | null
  action: StripAction
  data: StripData | null
}

export interface IndexSummaryLike {
  active: boolean
  scanning: boolean
  paused: boolean
  files: number
  bytesQueued: number
}

export interface DeriveStripsInput {
  role: ShareRole
  isYou: boolean
  loading?: boolean
  error?: boolean
  sourceMissing?: boolean
  indexing?: IndexSummaryLike | null
  foreignEnabled?: boolean
  mirrorSync?: { active: boolean; files: number; bytesRemaining: number; pct: number | null; indeterminate: boolean } | null
  ownerOnline?: boolean
  listing?: { truncated: boolean; shown: number; total: number; limit: number } | null
}

export function deriveStrips(input: DeriveStripsInput): FolderStrip[]
