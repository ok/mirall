// What each request resolves with, and the domain shapes those responses carry. Errors are out of
// band — a thrown AppError becomes { id, error, code } — so a response type describes success only.
//
// The shapes live here rather than in the renderer because they are the WIRE, and the wire is the
// contract's to describe: a second client generating types from it needs them, and the renderer is
// one consumer of the same vocabulary. src/renderer/types/types.ts re-exports every name it used to
// own, so the ~100 sites that import from there are untouched.
//
// Read by both ends. The renderer's request() resolves with RequestResponse[K], and the worker's
// ipc.handle(name, fn) only accepts a handler whose result is RequestResponse[name]; every handler
// module is type-checked by tsconfig.worker.json. The producer side binds only where the result has a
// type: a handler returning a value inferred as `any` from an untyped data-layer callee is not held
// until that callee is typed. The map at the bottom is total over RequestName by construction, so a
// request with no response cannot compile.
import type { FILE_STATUSES, SHARE_FILE_STATUSES, OWNED_MOUNT_STATUSES, FOREIGN_MOUNT_STATUSES, MIRROR_STATES } from './statuses.js'
import type { CATEGORIES, OUTCOMES, ACTOR_TYPES, TARGET_KINDS } from './audit-kinds.js'
import type { CANARY_STATES } from './reachability.js'
import type { DENY_OUTCOMES } from './deny-outcome.js'
import type { MemberReach } from './member-reach.js'
import type { RequestName } from './requests.js'
import type { PathHost } from './paths.js'
import type { PersonKey, PrincipalRef } from './principals.js'

/** A command that succeeded and has nothing to report. */
export interface Ack { ok: true }

// Our own identity, and the one shape that answers all three principal questions about it. The
// three keys resolve to one value today; they are separate fields so a consumer never has to assume
// that stays true.
export interface Profile extends PrincipalRef {
  displayName: string
  avatar: string | null
}

type MemberStatus = 'pending' | 'approved'

export interface SpaceMember {
  publicKey: PersonKey
  displayName: string
  online?: boolean
  // Folded in by useMembers from members:reach, as `online` is from members:online. Null wherever
  // that map has no entry for the member (network/member-reach.js says when it has none).
  reach?: MemberReach | null
  avatar?: string | null
  status?: MemberStatus
  looseCatalogKey?: string
  looseCatalogKeyEnc?: string
  looseCatalogEpoch?: number
}

// The slim roster shape spaces:list ships (no avatar / catalog-key fields — those are heavy or
// worker-internal); the full SpaceMember roster comes from the per-space space:members request.
interface SpaceMemberSummary {
  publicKey: PersonKey
  displayName: string
  online?: boolean
  status?: MemberStatus
}

export interface JoinRequest {
  publicKey: PersonKey
  displayName: string
  avatar?: string | null
}

// The answer `members:reach` gives, folded per person by network/member-reach.js.
export interface MembersReach {
  members: Record<PersonKey, MemberReach>
}

export interface Space {
  spaceId: string
  name: string
  icon: string
  topic: string
  created: string
  members: SpaceMemberSummary[]
  favorite?: boolean
  schemaVersion?: number
  status?: 'pending' | 'approved'
  pendingCount?: number
  memberCount?: number
  creatorDivergence?: boolean
  downloadFolder?: string
}

export type FileStatus = (typeof FILE_STATUSES)[number]

export interface FileEntry {
  path: string
  size: number
  hash: string
  owner: { displayName: string; publicKey: PersonKey }
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

export interface MirrorParticipant {
  mirrorer: PersonKey
  shareId: string
  state: (typeof MIRROR_STATES)[number]
  mountedAt: number
}

type ShareType = 'owned-folder'

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

export type OwnedMountStatus = (typeof OWNED_MOUNT_STATUSES)[number]

export interface OwnedFolderMount {
  // Whose disk mountPath is on. Tagged as the record crosses the wire, never in the store.
  host: PathHost
  spaceId: string
  shareId: string
  mountPath: string
  ignore: string[]
  createdAt: number
  lastScanCompletedAt?: number
  status?: OwnedMountStatus
  lastError?: string | null
  indexPaused?: boolean
  mountPointMissing?: boolean
}

export type ForeignMountStatus = (typeof FOREIGN_MOUNT_STATUSES)[number]

export interface ForeignFolderMount {
  // Whose disk mountPath is on. Tagged as the record crosses the wire, never in the store.
  host: PathHost
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

// The wire row, which is not quite the renderer's row: absence is `null` here and `undefined`
// there, and share-files-fold projects between them.
export interface ShareFileRow {
  relPath: string
  size: number
  hash: string
  mtime: number
  status: ShareFileStatus
  localPath: string | null
  verified?: boolean
  // Derived from an enabled mirror on this device, whose next pass restores the owner's version.
  mirrored?: boolean
  pendingBytes?: number
  errorCode?: string
  transferId?: string
}


interface MountValidationAdvisory {
  code: string
  message: string
}

export interface MountValidationResult {
  mountPath: string
  host: PathHost
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

export type CanaryState = (typeof CANARY_STATES)[number]

export interface CanaryResult {
  state: CanaryState
  at: number
  stage1?: { announceRecords: number; ms: number }
  stage2?: { dials: number; opened: number; ms: number }
}

export type AuditCategory = (typeof CATEGORIES)[number]
type AuditTier = 'A' | 'B' | 'C'
type AuditOutcome = (typeof OUTCOMES)[number]

interface AuditParty {
  type: (typeof ACTOR_TYPES)[number]
  key: PersonKey | null
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
  installId: string | null
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

// ---- shapes no renderer type covered -------------------------------------

// The raw space record create/join/update hand back, before slimSpaces has been over it: no counts
// yet, and it carries worker-internal fields the slim shape drops.
export interface SpaceRecord {
  spaceId: string
  name: string
  icon: string
  topic: string
  created: string
  members: SpaceMember[]
  schemaVersion?: number
  downloadFolder?: string
  status?: 'pending' | 'approved'
}

/** `false` when there is no key to grant with; otherwise whether the grant reached the peer. */
export type ApproveMemberResult = false | { granted: true, delivered: boolean }

type DenyOutcome = (typeof DENY_OUTCOMES)[number]
export type DenyMemberResult = { outcome: DenyOutcome }

export interface ShareFileListing {
  entries: ShareFileRow[]
  complete: boolean
  total: number
  totalBytes: number
  truncated?: boolean
  fileLimit?: number | null
}

export interface FolderInfo { fileCount: number, totalBytes: number, blobsLength: number | null }

/** A loose download: queued behind the engine, or started with a landing path. */
export type LooseDownloadResult =
  | { queued: true }
  | { transferId: string, finalPath: string }

/** A share read: already ours, mirrored by the folder engine, queued, or started. */
export type ShareDownloadResult =
  | { ok: true, alreadyOwned: true }
  | { ok: true, mirrored: true }
  | { queued: true }
  | { transferId: string, finalPath: string }

export interface OwnedMountResult { mount: OwnedFolderMount, advisories: MountValidationAdvisory[] }
export interface ForeignMountResult { mount: ForeignFolderMount, advisories: MountValidationAdvisory[] }
export interface ShareAndMountResult extends OwnedMountResult { share: Share }

export type AnyMount =
  | (OwnedFolderMount & { role: 'owned-folder' })
  | (ForeignFolderMount & { role: 'foreign-folder' })

export interface IndexStatus {
  queued: number
  running: number
  stalled: number
  done: number
  failed: number
  totalOnDisk: number | null
  bytesQueued: number
  adding: number
  order: string
  concurrency: number
}

export interface PauseIndexResult { cancelled: unknown, paused: true, mountPointGone: boolean }
export interface ResumeIndexResult { resumed: true, deep: boolean }

export interface ServeSummary {
  spaceId: string
  path: string
  peers: PersonKey[]
  bytes: number
  total: number
  pausedKeys: PersonKey[]
  // Members waiting on the file while we are still hashing it. Never in `peers`, never in the sums.
  waitingKeys: PersonKey[]
}

export interface ServeDetailPeer { personKey: PersonKey, bytes: number, total: number, paused: boolean, waiting: boolean }
export interface ServeDetailSnapshot { peers: ServeDetailPeer[] }

export interface AuditExport { version: number, exportedAt: number, entries: AuditEntry[] }
export interface AuditPurgeResult { purged: number }

export interface RelayApplyResult {
  ok: true
  applied: number
  reason?: string
  mismatch: 'stale-relayed' | 'stale-direct' | 'replaced-relay' | null
  reconnected: boolean
}

export interface RelayTestResult { ok: boolean, reason?: string }

export type ReconnectResult =
  | { ok: false, throttled: true }
  | { ok: true, control: number, content: number }

/** Narrower than the full Liveness shape: this handler reports no interfaceKind. */
export interface LivenessCheck { failures: number, checkedAt: number }

// The worker's half of the diagnostics bundle; the client splices its own logs onto it. The shape
// is large and still moving, so the members that are settled are named and the rest are honest
// about being open rather than described wrongly.
export interface WorkerDiagnostics {
  schema: number
  generatedAt: number
  redacted: boolean
  reference: string | null
  app: { version: string, channel: string, build: string }
  system: { platform: string, release: string, arch: string }
  verdict: { current: unknown, history: unknown[] }
  sweeps: unknown[]
  network: Record<string, unknown>
  canary: unknown
  liveness: unknown
  relaying: unknown
  relay: Record<string, unknown>
  requests: { metrics: Record<string, unknown>, failures: Record<string, number> }
  health: Record<string, unknown>
  spaces: { count: number, topics: unknown[] }
}


export interface StorageInfo {
  totalDiskUsage: number
  storagePath: string
  host: PathHost
  indexBytes: number
  dbBytes: number
}

export interface SpaceStorageSummary { totalBytes: number, onDeviceBytes: number }
export interface RootsStatus { unavailable: string[], host: PathHost }
export interface FeatureFlags { overlay: boolean, inPlaceFiles: boolean }
export interface VerboseState { verbose: boolean }
export interface PingResult { pong: true, timestamp: number }
export interface ResumeResult { epoch: string, head: number, gap: boolean, replayed: number }

// ---- the map --------------------------------------------------------------

interface Responses {
  'audit:actors': AuditActorRef[]
  'audit:configure': AuditConfig
  'audit:export': AuditExport
  'audit:get-config': AuditConfig
  'audit:list': AuditPage
  'audit:purge': AuditPurgeResult
  'audit:spaces': AuditSpaceRef[]
  'audit:stats': AuditStats
  'diagnostics:export': WorkerDiagnostics
  'downloads:roots-status': RootsStatus
  'event:foreign-folder-fs-event': Ack
  'event:loose-file-fs-event': Ack
  'event:owned-folder-fs-event': Ack
  'events:resume': ResumeResult
  'features:get': FeatureFlags
  'feedback:send': Ack
  'files:add': Ack
  'files:cancel-download': Ack
  'files:cancel-publish': Ack
  'files:discard-partial': Ack
  'files:download': LooseDownloadResult
  'files:list': FileEntry[]
  'files:pause-download': Ack
  'files:remove': Ack
  'files:reveal': Ack
  'foreign-folder:cancel-preview': Ack
  'foreign-folder:get': ForeignFolderMount | null
  'foreign-folder:list-all': ForeignFolderMount[]
  'foreign-folder:mount': ForeignMountResult
  'foreign-folder:preview': ScanPreview
  'foreign-folder:relocate': ForeignMountResult
  'foreign-folder:set-enabled': ForeignFolderMount
  'foreign-folder:unmount': Ack
  'foreign-folder:validate': MountValidationResult
  'members:online': string[]
  'members:reach': MembersReach
  'mounts:list-all': AnyMount[]
  'network:check-liveness': LivenessCheck
  'network:online-hint': Ack
  'network:probe-canary': CanaryResult
  'network:reconnect': ReconnectResult
  'network:set-relay': RelayApplyResult
  // The swarm snapshot is wide, still moving, and read by one screen that narrows it itself.
  // Naming it Record keeps this map honest rather than describing a shape that would drift.
  'network:status:get': Record<string, unknown>
  'network:test-relay': RelayTestResult
  'owned-folder:cancel-preview': Ack
  'owned-folder:delete': Ack
  'owned-folder:get': OwnedFolderMount | null
  'owned-folder:index-status': IndexStatus
  'owned-folder:list-all': OwnedFolderMount[]
  'owned-folder:mount': OwnedMountResult
  'owned-folder:pause-index': PauseIndexResult
  'owned-folder:preview': ScanPreview
  'owned-folder:relocate': OwnedMountResult
  'owned-folder:resume-index': ResumeIndexResult
  'owned-folder:validate': MountValidationResult
  'ping': PingResult
  'profile:get': Profile | null
  // Not nullable, unlike profile:get: the handler re-reads what it has just written, so by the
  // time this answers there is a profile.
  'profile:set': Profile
  'serving:detail-subscribe': ServeDetailSnapshot
  'serving:detail-unsubscribe': Ack
  'serving:summary-list': ServeSummary[]
  'setVerbose': VerboseState
  'settings:set-bandwidth': Ack
  'settings:set-download-folder': Ack
  'share:create': Share
  'share:create-and-mount': ShareAndMountResult
  'share:delete': Ack
  'share:discard-partial': Ack
  'share:folder-info': FolderInfo
  'share:list': Share[]
  'share:list-files': ShareFileListing
  'share:read-file': ShareDownloadResult
  'share:rename': Share
  'share:reveal-file': Ack
  'share:reveal-folder': Ack
  'shutdown': Ack
  'space:approve-member': ApproveMemberResult
  'space:create': SpaceRecord
  'space:deny-member': DenyMemberResult
  'space:invite': string
  'space:join': SpaceRecord
  'space:leave': Ack
  'space:members': SpaceMember[]
  'space:mirrors': MirrorParticipant[]
  'space:pending-requests': JoinRequest[]
  'space:storage-summary': SpaceStorageSummary
  'space:toggle-favorite': SpaceRecord | null
  'space:update': SpaceRecord | null
  'spaces:list': Space[]
  'storage:info': StorageInfo
}

// A mapped type over RequestName, not `keyof Responses`: a request added to REQUESTS with no entry
// here is a compile error on THIS line, and an entry naming a request that does not exist is one on
// the line below. Parity is a property of the types, not of a test somebody has to remember to run.
export type RequestResponse = { [K in RequestName]: Responses[K] }

type NoStrayResponses = Exclude<keyof Responses, RequestName> extends never ? true : never
const noStrays: NoStrayResponses = true
void noStrays
