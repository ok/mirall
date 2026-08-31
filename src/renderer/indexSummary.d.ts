export interface IndexStatus {
  queued?: number
  running?: number
  done?: number
  failed?: number
  totalOnDisk?: number | null
  bytesQueued?: number
}

export interface IndexSummary {
  active: boolean
  files: number
  running: number
  queued: number
  bytesQueued: number
}

export function deriveIndexSummary(status: IndexStatus | null | undefined): IndexSummary
