import type { Decoration } from './hooks/useDecorations.js'
import type { FileEntry, FileStatus, PeerDownloadSummary } from './types.js'

export type FileCardLane = 'publish' | 'verify' | 'download' | 'preparing' | 'indicator' | 'rest'

export interface FileCardView {
  lane: FileCardLane
  indicatorActive: boolean
  displayStatus: FileStatus
  isDownloading: boolean
  downloadDecor: Decoration | null
  publishDecor: Decoration | null
  preparingDecor: Decoration | null
  progressBytes: number | undefined
  progressTotal: number | undefined
  verifyPct: number
  publishPct: number
  downloadPct: number
  preparingPct: number
  showVerified: boolean
}

export function deriveFileCardView(
  file: FileEntry,
  decoration: Decoration | null,
  downloadSummary: PeerDownloadSummary | null | undefined,
): FileCardView
