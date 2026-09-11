import type { FILE_STATUSES, BADGE_STATUSES, SHARE_FILE_STATUSES, OWNED_MOUNT_STATUSES, FOREIGN_MOUNT_STATUSES, MIRROR_STATES } from '../shared/contract/statuses.js'
import type { CATEGORIES, OUTCOMES, ACTOR_TYPES, TARGET_KINDS } from '../shared/contract/audit-kinds.js'
export interface Profile {
  displayName: string
  avatar: string | null
  publicKey: string
}

type MemberStatus = 'pending' | 'approved'

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
interface SpaceMemberSummary {
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
  downloadFolder?: string
}

export type FileStatus = (typeof FILE_STATUSES)[number]

export type BadgeStatus = (typeof BADGE_STATUSES)[number]

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
  state: (typeof MIRROR_STATES)[number]
  mountedAt: number
}

type ShareType = 'owned-folder'

export type ShareRole = 'mine' | 'browse' | 'mirrored'

export interface Share {
  id: string
  type: ShareType
  /** The immutable on-disk folder name. Also the first segment of the consumer drive path, so it
   *  keys download claims and pending transfers — never rewrite it. `displayName` is the label. */
  name: string
  displayName?: string
  owner: string
  spaceId: string
  createdAt: number
  deletedAt?: number
}

type OwnedMountStatus = (typeof OWNED_MOUNT_STATUSES)[number]

export interface OwnedFolderMount {
  spaceId: string
  shareId: string
  mountPath: string
  ignore: string[]
  createdAt: number
  lastScanCompletedAt?: number
  status?: OwnedMountStatus
  lastError?: string | null
  indexPaused?: boolean
}

export type ForeignMountStatus = (typeof FOREIGN_MOUNT_STATUSES)[number]

export interface ForeignFolderMount {
  spaceId: string
  shareId: string
  mountPath: string
  enabled: boolean
  attachedAt: number
  initialScanCompletedAt?: number
  status?: ForeignMountStatus
  lastError?: string | null
}

export type ShareFileStatus = (typeof SHARE_FILE_STATUSES)[number]

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

type FileTreeStatusCategory = 'on-device' | 'downloading' | 'preparing' | 'available' | 'paused' | 'error'

interface FileTreeFileNode {
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

interface MountValidationAdvisory {
  code: string
  message: string
}

export interface MountValidationResult {
  mountPath: string
  advisories: MountValidationAdvisory[]
}

interface ScanPreviewEntry {
  relPath: string
  size: number
  conflict?: boolean
}

type ScanPreviewFlow = 'add-owned-folder' | 'mount-foreign-folder' | 'move-foreign-folder'

export interface ScanPreview {
  flow: ScanPreviewFlow
  toUpload: number
  toDownload: number
  conflicts: number
  existingAtDestination: number
  totalBytes: number
  perFile: ScanPreviewEntry[]
  perFileOmitted?: boolean
  // The folder's total file count against the limit, so the confirmation step can act before the
  // user commits. Both flows carry it; only the owned one can REFUSE on overFileLimit, because
  // mounting a peer share creates no share of your own. A mirror over the display cap sets
  // listingAdvisory instead: a warning it can proceed past, not a wall.
  totalFiles?: number
  fileLimit?: number
  overFileLimit?: boolean
  listingAdvisory?: boolean
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

export type ReachabilityVerdict = 'healthy' | 'at-risk' | 'blocked' | 'unknown'

export type ReachabilityCause =
  | 'os-offline'
  | 'dht-unreachable'
  | 'no-public-address'
  | 'symmetric-nat'
  | 'udp-degraded'
  | 'peers-unreachable'
  | 'vpn-only-route'

type CanaryState = 'unavailable' | 'pending' | 'seeder-down' | 'reachable' | 'unreachable'

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
  confidence: 'measured' | 'predicted'
  evidence: ReachabilityEvidence | null
  since: number
}

interface PeerReach {
  discovered: number
  connected: number
  exhausted: number
}

interface DhtHealth {
  online: boolean
  degraded: boolean
  cold: boolean
  idle: boolean
  timeoutsRate: number
}

export interface CanaryResult {
  state: CanaryState
  at: number
  stage1?: { announceRecords: number; ms: number }
  stage2?: { dials: number; opened: number; ms: number }
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
  peerReach: PeerReach
  dhtHealth: DhtHealth
  canary: CanaryResult
  liveness: Liveness
  reachability: Reachability
  versions: {
    dht: string
  }
}

export type AuditCategory = (typeof CATEGORIES)[number]
type AuditTier = 'A' | 'B' | 'C'
type AuditOutcome = (typeof OUTCOMES)[number]

interface AuditParty {
  type: (typeof ACTOR_TYPES)[number]
  key: string | null
  name: string | null
}

export interface AuditSpaceRef {
  id: string
  name: string | null
}

interface AuditTargetRef {
  kind: (typeof TARGET_KINDS)[number]
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
