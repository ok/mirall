import type { Decoration } from './hooks/useDecorations.js'
import type { BadgeAppearance } from './statusBadge.js'
import type { FileEntry, FileStatus, ShareFileEntry, ShareFileStatus, PeerDownloadSummary } from './types.js'

export type LaneName = 'publish' | 'verify' | 'download' | 'preparing' | 'indicator' | 'rest'
export type RowKind = 'loose' | 'share'

export interface RowView {
  lane: LaneName
  indicatorActive: boolean
  badge: BadgeAppearance
  displayStatus: FileStatus | ShareFileStatus
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

export interface RowViewOptions {
  kind?: RowKind
  /** Share rows only: our own share collapses `synced` to the `mine` pill. */
  isOwn?: boolean
  /** The download was just requested and no decoration has arrived yet. See seedFrame. */
  seeded?: boolean
}

export function rowBytesOnDevice(row: FileEntry | ShareFileEntry, decoration: Decoration | null): number

export function deriveRowView(
  row: FileEntry | ShareFileEntry,
  decoration: Decoration | null,
  downloadSummary: PeerDownloadSummary | null | undefined,
  opts?: RowViewOptions,
): RowView
