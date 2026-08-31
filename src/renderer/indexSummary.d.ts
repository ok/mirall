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
  /** Walking the disk, with nothing queued yet — the phase no queue depth can report. */
  scanning: boolean
  /** The durable pause, independent of `active`: pausing drops the queue, so a paused index adds 0. */
  paused: boolean
  files: number
  bytesQueued: number
}

export function deriveIndexSummary(
  status: IndexStatus | null | undefined,
  mount?: { indexPaused?: boolean; scanning?: boolean } | null,
): IndexSummary
