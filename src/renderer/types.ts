export interface Profile {
  displayName: string
  avatar: string | null
  publicKey: string
}

export type MemberStatus = 'pending' | 'approved'

export interface SpaceMember {
  publicKey: string
  driveKey: string
  displayName: string
  online?: boolean
  avatar?: string | null
  status?: MemberStatus
  looseCatalogKey?: string
  looseCatalogKeyEnc?: string
}

// The slim roster shape spaces:list ships (no avatar / catalog-key fields — those are heavy or
// worker-internal); the full SpaceMember roster comes from the per-space space:members request.
export interface SpaceMemberSummary {
  publicKey: string
  driveKey: string | null
  displayName: string
  online?: boolean
  status?: MemberStatus
}

export interface JoinRequest {
  publicKey: string
  displayName: string
  avatar?: string | null
}

export interface Space {
  spaceId: string
  name: string
  icon: string
  topic: string
  created: string
  members: SpaceMemberSummary[]
  driveKey?: string
  favorite?: boolean
  schemaVersion?: number
  status?: 'pending' | 'approved'
  pendingCount?: number
  memberCount?: number
  creatorDivergence?: boolean
}

export type FileStatus =
  | 'mine'
  | 'downloaded'
  | 'remote'
  | 'preparing'
  | 'downloading'
  | 'verifying'
  | 'publishing'
  | 'paused-interrupted'
  | 'paused-offline'
  | 'unavailable'
  | 'error'

export type BadgeStatus =
  | 'mine'
  | 'on-device'
  | 'available'
  | 'downloading'
  | 'verifying'
  | 'preparing'
  | 'publishing'
  | 'paused'
  | 'owner-offline'
  | 'unavailable'
  | 'error'

export interface FileEntry {
  path: string
  size: number
  hash: string
  owner: { displayName: string; publicKey: string }
  driveKey: string
  localBytes: number
  isAvailable: boolean
  status: FileStatus
  pendingBytes?: number
  sharedByCount?: number
  errorCode?: string
  inPlace?: boolean
  verified?: boolean
  transferId?: string
}

// Sender-side download indicator. Summary is the always-on aggregate (who + how
// far, drives the collapsed avatar stack); PeerDownloadPeer is one expanded row.
export interface PeerDownloadSummary {
  spaceId: string
  path: string
  peerKeys: string[]
  pausedKeys: string[]
  // bytes/total are aggregate SUMS across the downloaders (bytes/total = average
  // progress for the collapsed bar) — NOT a single file's size: with N downloaders
  // of an F-byte file, total ≈ N·F.
  bytes: number
  total: number
  avgSpeed: number
}

export interface PeerDownloadPeer {
  peerKey: string
  bytes: number
  total: number
  avgSpeed: number
  paused: boolean
}

export interface MirrorParticipant {
  mirrorer: string
  shareId: string
  state: 'syncing' | 'synced' | 'paused'
  mountedAt: number
}

export type ShareType = 'owned-folder'

export type ShareRole = 'mine' | 'browse' | 'mirrored'

export interface Share {
  id: string
  type: ShareType
  name: string
  owner: string
  spaceId: string
  createdAt: number
  deletedAt?: number
}

export type OwnedMountStatus = 'scanning' | 'active' | 'paused-error' | 'mount-point-gone'

export interface OwnedFolderMount {
  spaceId: string
  shareId: string
  mountPath: string
  ignore: string[]
  createdAt: number
  lastScanCompletedAt?: number
  status?: OwnedMountStatus
  lastError?: string | null
}

export type ForeignMountStatus =
  | 'idle'
  | 'scanning'
  | 'active'
  | 'paused'
  | 'paused-enospc'
  | 'paused-error'
  | 'mount-point-gone'

export interface ForeignFolderMount {
  spaceId: string
  shareId: string
  mountPath: string
  enabled: boolean
  attachedAt: number
  initialScanCompletedAt?: number
  status?: ForeignMountStatus
}

export type ShareFileStatus =
  | 'remote'
  | 'preparing'
  | 'downloading'
  | 'verifying'
  | 'downloaded'
  | 'synced'
  | 'unavailable'
  | 'paused-interrupted'
  | 'paused-offline'
  | 'error'

export interface ShareFileEntry {
  relPath: string
  size: number
  hash: string
  mtime: number
  status: ShareFileStatus
  localPath?: string
  verified?: boolean
  pendingBytes?: number
  errorCode?: string
  verifyFraction?: number
  transferId?: string
  progress?: {
    bytes: number
    total: number
    speed: number
    avgSpeed?: number
    eta?: number | null
    phase?: 'verifying'
  }
}

export type FileTreeStatusCategory = 'on-device' | 'downloading' | 'available' | 'paused' | 'error'

export interface FileTreeFileNode {
  kind: 'file'
  name: string
  path: string
  depth: number
  entry: ShareFileEntry
}

export interface FileTreeFolderNode {
  kind: 'folder'
  name: string
  path: string
  depth: number
  children: FileTreeNode[]
  fileCount: number
  folderCount: number
  totalBytes: number
  statusCounts: Record<FileTreeStatusCategory, number>
}

export type FileTreeNode = FileTreeFileNode | FileTreeFolderNode

export interface MountValidationAdvisory {
  code: string
  message: string
}

export interface MountValidationResult {
  mountPath: string
  advisories: MountValidationAdvisory[]
}

export interface ScanPreviewEntry {
  relPath: string
  size: number
  conflict?: boolean
}

export type ScanPreviewFlow = 'add-owned-folder' | 'mount-foreign-folder' | 'move-foreign-folder'

export interface ScanPreview {
  flow: ScanPreviewFlow
  toUpload: number
  toDownload: number
  conflicts: number
  existingAtDestination: number
  totalBytes: number
  perFile: ScanPreviewEntry[]
  perFileOmitted?: boolean
  // Owned-folder flow only: the folder's total file count against the share limit, so the
  // confirmation step can refuse before the user commits.
  totalFiles?: number
  fileLimit?: number
  overFileLimit?: boolean
}

export interface PreviewProgress {
  phase: 'enumerating' | 'scanning' | 'hashing'
  scanned: number
  total: number
  bytes: number
}

export interface UpdateInfo {
  app: boolean
  version: { fork: number; length: number; semver: string | null }
}

export type ConnectivityState = 'online' | 'connecting' | 'offline'

export interface NetworkStatusStats {
  updates: number
  connects: {
    client: { opened: number; closed: number; attempted: number }
    server: { opened: number; closed: number; attempted: number }
  }
  bannedPeers: number
}

export interface NetworkStatus {
  state: ConnectivityState
  dhtReady: boolean
  announced: boolean
  peerCount: number
  connecting: number
  suspended: boolean
  lastConnectionAt: number | null
  bootedAt: number
  identity: {
    publicKey: string
    nodeId: string | null
  }
  address: {
    publicHost: string | null
    publicPort: number
    localPort: number
  }
  nat: {
    firewalled: boolean | null
    randomized: boolean | null
    ephemeral: boolean
  }
  routing: {
    bootstrap: string[]
    tableSize: number
  }
  topics: number
  stats: NetworkStatusStats
  versions: {
    dht: string
  }
}

export type AuditCategory = 'members' | 'files' | 'folders' | 'security'
export type AuditTier = 'A' | 'B' | 'C'
export type AuditOutcome = 'ok' | 'denied' | 'error'

export interface AuditParty {
  type: 'self' | 'peer' | 'system'
  key: string | null
  name: string | null
}

export interface AuditSpaceRef {
  id: string
  name: string | null
}

export interface AuditTargetRef {
  kind: string | null
  id: string | null
  name: string | null
}

export interface AuditEntry {
  v: number
  seq: number
  ts: number
  tzOffset: number
  kind: string
  category: AuditCategory
  tier: AuditTier
  outcome: AuditOutcome
  code: string | null
  device: string | null
  actor: AuditParty | null
  space: AuditSpaceRef | null
  target: AuditTargetRef | null
  subject: Record<string, string | number | boolean | null> | null
  search: string
}

export interface AuditPage {
  entries: AuditEntry[]
  nextCursor: number | null
}

export interface AuditConfig {
  enabled: boolean
  retentionDays: number
  maxEntries: number
}

export interface AuditStats {
  count: number
  oldestTs: number | null
  newestTs: number | null
  oldestSeq: number | null
  newestSeq: number | null
}

export interface AuditActorRef {
  key: string
  name: string | null
}

export interface AuditFilters {
  spaceId: string | null
  categories: AuditCategory[]
  actorKey: string | null
  search: string
  sinceDays: number | null
}
