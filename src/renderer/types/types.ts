import type {
  ShareFileStatus, CanaryState, CanaryResult, AuditCategory,
} from '../../shared/contract/responses.js'
import type { BADGE_STATUSES } from '../../shared/contract/statuses.js'
import type { VERDICTS, CAUSES, CONFIDENCES } from '../../shared/contract/reachability.js'

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

export type BadgeStatus = (typeof BADGE_STATUSES)[number]

export type ShareRole = 'mine' | 'browse' | 'mirrored'

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
  transferId?: string
}

export type FileTreeStatusCategory = 'on-device' | 'downloading' | 'preparing' | 'available' | 'paused' | 'error'

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

export type ConnectivityState = 'online' | 'limited' | 'connecting' | 'offline'

interface NetworkStatusStats {
  updates: number
  connects: {
    client: { opened: number; closed: number; attempted: number }
    server: { opened: number; closed: number; attempted: number }
  }
  bannedPeers: number
  relaying: { selected: number; attempts: number; successes: number; aborts: number }
}

export type ReachabilityVerdict = (typeof VERDICTS)[number]
export type ReachabilityConfidence = (typeof CONFIDENCES)[number]

export type ReachabilityCause = (typeof CAUSES)[number]

interface ReachabilityEvidence {
  peersDiscovered: number
  peersConnected: number
  peersExhausted: number
  dialsAttempted: number
  dialsOpened: number
  publicPort: number
  canary: CanaryState
}

export interface Reachability {
  verdict: ReachabilityVerdict
  cause: ReachabilityCause | null
  confidence: ReachabilityConfidence
  evidence: ReachabilityEvidence | null
  since: number
}

export type RelayPlane = 'control' | 'content'

interface PeerReach {
  discovered: number
  connected: number
  exhausted: number
}

export interface RelayedConnection {
  peerKey: string
  profileKey: string | null
  plane: RelayPlane
  displayName: string | null
  via: 'own' | 'adopted'
  relayKey: string
  since: number
}

export interface RelayStatus {
  connections: RelayedConnection[]
  direct: Record<RelayPlane, number>
  seen: number
  digest: string
}

interface DhtHealth {
  online: boolean
  degraded: boolean
  cold: boolean
  idle: boolean
  timeoutsRate: number
}

interface Liveness {
  failures: number
  checkedAt: number
  interfaceKind: 'none' | 'tunnel-only' | 'physical'
}

// Only present in a bundle while THIS build has an update apply it has not got past — see
// src/main/apply-error.js.
export interface ApplyErrorReport {
  timestamp: string | null
  version: string | null
  platform: string | null
  message: string
  stack: string | null
}

export interface DiagnosticLogEntry {
  at: number
  source: string
  level: string
  text: string
}

export interface NetworkStatusScreen {
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
  peerReach: PeerReach
  dhtHealth: DhtHealth
  canary: CanaryResult
  liveness: Liveness
  relay: RelayStatus
  reachability: Reachability
  versions: {
    dht: string
  }
}

export interface AuditFilters {
  spaceId: string | null
  categories: AuditCategory[]
  actorKey: string | null
  search: string
  sinceDays: number | null
}

// The wire vocabulary moved to the contract — it is what a response carries, and a second client
// generates from it. Re-exported here so the sites that import these names do not care.
export type {
  Profile, SpaceMember, JoinRequest, Space, FileStatus, FileEntry, MirrorParticipant, Share,
  OwnedMountStatus, OwnedFolderMount, ForeignMountStatus, ForeignFolderMount,
  ShareFileStatus, MountValidationResult, ScanPreview,
  CanaryState, CanaryResult,
  AuditCategory, AuditSpaceRef, AuditEntry, AuditPage, AuditConfig, AuditStats, AuditActorRef,
} from '../../shared/contract/responses.js'
