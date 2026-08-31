export interface IndexStatus {
  /** Publish work only — the queue also carries retires, which are not additions. */
  adding?: number
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
  bytesQueued: number
}

export function deriveIndexSummary(status: IndexStatus | null | undefined): IndexSummary
