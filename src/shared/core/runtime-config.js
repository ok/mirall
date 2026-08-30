const DEFAULT_PEER_READ_TIMEOUT_MS = 8000
// Upper bound on how long an approver waits to durably capture a joiner's own membership
// record at approval time (the joiner is connected then; see captureJoinerMembership).
// 0 disables the capture. Tests shrink it to exercise the timeout / disabled paths.
const DEFAULT_CAPTURE_MEMBER_RECORD_MS = 5000
const DEFAULT_LIST_FILES_CAP = 5000
const DEFAULT_MAX_FILES_PER_SHARE = 5000
// Kept in lockstep with PUBLISH_ORDERS in folders/work-item.js (a unit test asserts parity);
// core/ must not import from folders/.
export const PUBLISH_ORDERS = ['fifo', 'smallest-first', 'largest-first']
const DEFAULT_PUBLISH_ORDER = 'smallest-first'

// Single source of truth for every runtime-config field. Both the live default state and each
// setRuntimeConfig(next) call derive from these tables, so every default is declared exactly once.
// The coercion groups are kept distinct because their falsy-handling differs and must not drift:
//  NULLABLE — `next || null`: any falsy override (including '') collapses to null.
//  BOOLEAN — `!!next`: a strict boolean, default false.
//  DEFAULTED — `next ?? default`: nullish-only fallback, so a 0 / Infinity override is honored
//  (the "disable this cap" escape hatch).

// Paths / opaque strings; a falsy override means "unset". dhtBootstrap is test-only — a local
// hyperdht/testnet bootstrap so integration tests stay off the public DHT; null → default.
const NULLABLE = ['storage', 'appVersion', 'downloadFolder', 'dhtBootstrap', 'upgradeKey']

// Dev toggles + feature flags, all default-off.
const BOOLEAN = [
  'dev', 'verbose',
  'membershipApprovalEnabled', 'handshakeIdentityBindingEnabled', 'relayEnabled',
]

// Numeric budgets / timeouts, mostly DoS / resource bounds: each caps how much work, memory,
// or wall-clock a remote peer (or a huge local folder) can make this process spend. A 0 or Infinity
// override is meaningful — usually "disable this cap" — so these fall back only on null/undefined.
// Tests shrink them to exercise the bound deterministically. peerReadTimeoutMs is a test-only
// override of the per-peer profile-bee read budget; production always uses the default.
const DEFAULTED = {
  peerReadTimeoutMs: DEFAULT_PEER_READ_TIMEOUT_MS,
  // Read budget for the INTERACTIVE list fan-outs (files:list / share:list). Much shorter than
  // peerReadTimeoutMs so a not-yet-replicated member can't freeze the list — it returns the
  // locally-available rows now and self-heals: event:shares-updated / event:files-updated re-run
  // the listing once that peer's bee appends. The full peerReadTimeoutMs stays reserved for
  // correctness-critical reads (mirror / foreign-folder). Tests shrink it; a 0 override is honored.
  interactiveReadTimeoutMs: 1500,
  // Upper bound on how many file rows share:list-files materialises + ships in one IPC
  // frame. A folder with 150k files would otherwise build a ~150k-row array (+ a giant
  // JSON.stringify) per read and render every row un-virtualised → the worker hits V8's
  // ~4GB ceiling and dies ("huge folder freezes the app"). Past the cap the renderer
  // shows "first N of M" (the true total is streamed separately). 0 / Infinity disables.
  //
  // RAISING THIS REQUIRES VIRTUALISING THE FILE LIST FIRST. The number is not a policy
  // choice — it is the bound that keeps an un-windowed list renderable. maxFilesPerShare
  // is held equal to it so a folder we ADMIT always renders in full.
  listFilesCap: DEFAULT_LIST_FILES_CAP,
  // Max files in a folder a user may SHARE — an admission gate enforced at add-folder time
  // (and in the worker), NOT a runtime ceiling: an already-shared folder that GROWS past this
  // keeps publishing, because silently refusing to publish would leave the folder incomplete on
  // every peer — a far worse failure than a truncated list. Growth surfaces a warning instead,
  // and the gate never fires on remount/relocate/reconcile. 0 / Infinity disables it.
  maxFilesPerShare: DEFAULT_MAX_FILES_PER_SHARE,
  captureMemberRecordMs: DEFAULT_CAPTURE_MEMBER_RECORD_MS,
  deepReconcileEvery: 4,
  // Owner-side publish slots across all spaces. Hashing is synchronous CPU on the worker thread;
  // 2 overlaps one file's reads with another's hashing, beyond that gains nothing. The scheduler
  // clamps to >= 1.
  publishConcurrency: 2,
  // Concurrent overlay downloads. A reconnect can have hundreds of pending rows and each running
  // fetch owns a chunk scheduler, a watchdog, an fd and a progress ticker. 0 disables the gate.
  downloadConcurrency: 3,
  // Only topic-MATCHED identity frames charge this lane (the receiver resolves the topic
  // before charging). An honest connection sends one frame per shared space, we reciprocate
  // each, and a name change or ledger re-send can add a third inside one refill window — so
  // the lane's burst is handshakeBurst + handshakeBurstPerTopic x the topics THIS peer joined
  // (createDualRateLimiter reads the count per take). Refill and the consecutive-drop ban are
  // unchanged: a flood is anything past that cap at 1 frame/s. A fixed burst of 8 banned a
  // peer sharing 24+ spaces on every reconnect. burstPerTopic 0 restores the fixed burst;
  // handshakeBurst 0 still switches the lane off.
  handshakeBurst: 8,
  handshakeBurstPerTopic: 3,
  handshakeRefillMs: 1000,
  handshakeAbuseThreshold: 24,
  // Frames naming a topic we did not join: dropped before any signature verify, so the lane
  // can be generous (mirrors the overlay serve limiter). Bans only on a sustained flood.
  // Every peer frame is metered on a general lane, not just the two identity types. Presence is
  // the busiest honest source at one frame per (peer, space) per 5 s, so 256/20ms leaves an order
  // of magnitude of headroom. peerFrameBurst 0 switches the lane off; peerFrameMaxBytes 0 the cap.
  peerFrameMaxBytes: 65536,
  peerFrameBurst: 256,
  peerFrameRefillMs: 20,
  peerFrameAbuseThreshold: 512,
  handshakeUnmatchedBurst: 32,
  handshakeUnmatchedRefillMs: 250,
  handshakeUnmatchedAbuseThreshold: 256,
  // Convergence tick + re-announce schedule: one slow global timer in swarm.js; all its work
  // is deficit-gated. convergenceTickMs 0 disables the tick (and with it re-announce and
  // escalation). Tests shrink these.
  convergenceTickMs: 15_000,
  announceBaseMs: 10_000,
  announceCapMs: 60_000,
  announceMaxAttempts: 4,
  dupReciprocalFloorMs: 10_000,
  convergenceEscalateTicks: 4,
  convergenceRefreshMinMs: 300_000,
  // Give up escalating an UNCHANGED roster deficit after this many discovery refreshes: a
  // deficit that survives several refreshes is a peer who won't materialize (an approved-then-
  // offline joiner), not a stalled stream a refresh can heal. Reset when the deficit clears.
  convergenceMaxEscalations: 3,
  // TEST-ONLY (like dhtBootstrap): drop inbound identity frames with 0-based index in
  // [after, after+count) — a deterministic lossy-link lever for flow tests. count 0 = off.
  testDropIdentityFramesAfter: 0,
  testDropIdentityFramesCount: 0,
  // TEST-ONLY (like dhtBootstrap / testDropIdentityFrames): stop a peer-catalog drain after this
  // many entries and report the read INCOMPLETE — a deterministic "the listing was truncated"
  // lever, so the mirror-deletion guard can be exercised without racing a real drain timeout.
  // 0 = off; production never sets it.
  testTruncatePeerDrainAfter: 0,
  maxServerConnections: 32,
  maxClientConnections: 32,
  maxPendingRequesters: 64,
  maxMembersPerSpace: 256,
  maxApprovalsPerMember: 128,
  maxRequestsPerMember: 64,
  maxInvitesPerMember: 64,
  // Abuse guard on peer-bee capture (explicit-get contiguous copy of a roster bee);
  // real roster bees are tens of blocks. Tests shrink it.
  peerBeeCaptureMaxBlocks: 4096,
  // Bound on peer-controlled avatars (data-URI string length) so a malicious profile can't
  // balloon memory or the renderer. Keep in sync with AVATAR_MAX_BYTES in identity-limits.js
  // (a unit test asserts they match). 0 disables it.
  maxAvatarBytes: 256 * 1024,
  deriveDebounceMs: 150,
  // Serve-side cache of DECODED chunk maps, in bytes (~160 B per chunk entry). A chunk-need
  // used to re-read and JSON-decode the file's whole map from the file-index bee, about once
  // per chunk served. 32 MiB holds ~200k entries: twenty concurrent 10 GiB tier-3 serves or
  // two 100 GiB ones; a single larger map is still admitted (the cache keeps its newest
  // entry). 0 disables the cache — the no-build rollback; Infinity unbounds it.
  serveChunkMapCacheBytes: 32 * 1024 * 1024,
  // Foreign-mirror materialize poll cadence. Tests shrink it to assert orphan-mount teardown
  // (owner left → unmount) promptly; production uses the 30s default.
  foreignPollIntervalMs: 30_000,
  // Per-requester rate limit on the overlay serve gate (inbound content-requests),
  // keyed on the asker's authenticated profile key. More
  // generous than the handshake limiter — a legit consumer issues one request
  // per file when syncing a folder. 0 burst disables it. Tests shrink them.
  overlayServeBurst: 32,
  overlayServeRefillMs: 250,
  overlayServeAbuseThreshold: 256,
  // Owner-side catalog write batching during a folder scan: flush the buffered
  // advertise/setHash/tombstone ops on whichever comes first. Coarser, atomic heads
  // → smoother, consistent propagation to browsing peers. Tests shrink them.
  catalogFlushMs: 2500,
  catalogFlushMaxOps: 256,
  // TEST-ONLY (like dhtBootstrap / testDropIdentityFrames): shape THIS peer's swarm
  // connections to reproduce bad real-world links in flow tests. null = off. Applied per
  // connection in swarm.js (applyNetImpairment); production never sets it. Shape:
  //   { latencyMs, jitterMs }       delay every outbound frame (models RTT / loss-retransmit)
  //   { flapEveryMs, flapJitterMs }  periodically destroy each live connection (a flaky link →
  //                                  reconnect churn, handshake re-rate-limiting, state re-sync)
  netImpair: null,
  // User-facing content-plane transfer caps, KB/s, 0 = unlimited (the default). Unlike the
  // protective bounds above these fail OPEN — see getBandwidthLimits.
  downloadKBps: 0,
  uploadKBps: 0,
  // TEST-ONLY: how long a peer must be unreachable before the audit log records the absence.
  // 0 = use peer-episodes.js's own default, which is what production always runs. Flow tests
  // shrink it because five minutes of wall-clock is not a test.
  peerPresenceDwellMs: 0,
}

function coercePublishOrder(next) {
  return PUBLISH_ORDERS.includes(next?.publishOrder) ? next.publishOrder : DEFAULT_PUBLISH_ORDER
}

function buildConfig(next) {
  const out = {}
  for (const k of NULLABLE) out[k] = next?.[k] || null
  for (const k of BOOLEAN) out[k] = !!next?.[k]
  for (const k of Object.keys(DEFAULTED)) out[k] = next?.[k] ?? DEFAULTED[k]
  // Overlay is the only content backend and ships on; default ON, only an explicit
  // `false` override degrades shares to UNSUPPORTED.
  out.overlayEnabled = next?.overlayEnabled !== false
  out.inPlaceFilesEnabled = next?.inPlaceFilesEnabled !== false
  // Bulk content rides its own transport by default; only an explicit `false` reverts to the
  // single-plane overlay (control + content on one stream).
  out.separateContentPlane = next?.separateContentPlane !== false
  // An owner broadcasts hashing progress for a file it is (re-)publishing, so members see
  // "preparing 34%" instead of a frozen placeholder. It is also the liveness signal that keeps a
  // download parked on a re-publish alive: a source that hashes for hours (multi-TB) re-arms the
  // receiver's wait with every frame, so the wait bounds SILENCE rather than the hash. Default on;
  // only an explicit `false` reverts.
  out.sharePrepareProgressEnabled = next?.sharePrepareProgressEnabled !== false
  // Relay config is carried whether or not the flag is on; relayEnabled is the gate,
  // and setRelayThrough refuses to install a relay function without it.
  out.relayMode = next?.relayMode === 'auto' || next?.relayMode === 'always' ? next.relayMode : 'off'
  out.relays = Array.isArray(next?.relays) ? next.relays : []
  out.publishOrder = coercePublishOrder(next)
  return out
}

let config = buildConfig()

export function setRuntimeConfig(next) {
  config = buildConfig(next)
}

export function setDownloadFolder(folder) {
  config = { ...config, downloadFolder: folder }
}

export function setBandwidthLimits({ downloadKBps, uploadKBps } = {}) {
  config = {
    ...config,
    downloadKBps: coerceKBps(downloadKBps, config.downloadKBps),
    uploadKBps: coerceKBps(uploadKBps, config.uploadKBps),
  }
}

function coerceKBps(next, fallback) {
  if (next === undefined || next === null) return fallback
  return typeof next === 'number' && Number.isFinite(next) && next >= 0 ? next : fallback
}

export function getRuntimeConfig() {
  return config
}

export function getPeerPresenceDwellMs() {
  return config.peerPresenceDwellMs
}

export function isMembershipApprovalEnabled() {
  return config.membershipApprovalEnabled
}

export function isHandshakeIdentityBindingEnabled() {
  return config.handshakeIdentityBindingEnabled
}

export function isOverlayEnabled() {
  return config.overlayEnabled
}

export function isInPlaceFilesEnabled() {
  return config.inPlaceFilesEnabled
}

export function isSharePrepareProgressEnabled() {
  return config.sharePrepareProgressEnabled
}

export function isSeparateContentPlaneEnabled() {
  return config.separateContentPlane
}

export function getUpgradeKey() {
  return config.upgradeKey
}

export function isRelayEnabled() {
  return config.relayEnabled
}

export function getRelayConfig() {
  return { mode: config.relayMode, relays: config.relays }
}

export function setRelayConfig(mode, relays) {
  const relayMode = mode === 'auto' || mode === 'always' ? mode : 'off'
  config = { ...config, relayMode, relays: Array.isArray(relays) ? relays : [] }
}

export function getOverlayServeLimit() {
  const c = config
  return { burst: c.overlayServeBurst, refillMs: c.overlayServeRefillMs, abuseThreshold: c.overlayServeAbuseThreshold }
}

export function getDeepReconcileEvery() {
  return config.deepReconcileEvery
}

// A budget that is multiplied by a live count must be finite and non-negative: Infinity yields
// NaN against a zero count (which reads as "lane disabled" and fails OPEN), a negative yields a
// cap no frame can meet (fails closed on honest peers). Anything else falls back to the default.
function finiteAtLeast(value, min, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min ? value : fallback
}

export function getPublishConcurrency() {
  const n = config.publishConcurrency
  if (n === Infinity) return Infinity
  if (typeof n === 'number' && Number.isFinite(n) && n >= 1) return Math.floor(n)
  return DEFAULTED.publishConcurrency
}

export function getPeerFrameMaxBytes() {
  return finiteAtLeast(config.peerFrameMaxBytes, 0, DEFAULTED.peerFrameMaxBytes)
}

export function getPeerFrameLimits() {
  const c = config
  return {
    burst: finiteAtLeast(c.peerFrameBurst, 0, DEFAULTED.peerFrameBurst),
    refillMs: finiteAtLeast(c.peerFrameRefillMs, 1, DEFAULTED.peerFrameRefillMs),
    abuseThreshold: finiteAtLeast(c.peerFrameAbuseThreshold, 1, DEFAULTED.peerFrameAbuseThreshold),
  }
}

export function getDownloadConcurrency() {
  const n = config.downloadConcurrency
  if (typeof n === 'number' && Number.isFinite(n) && n >= 0) return Math.floor(n)
  return DEFAULTED.downloadConcurrency
}

export function getPublishOrder() {
  return config.publishOrder
}

// A protective bound must fail SAFE: an explicit 0/Infinity disables the cap (returns Infinity
// so callers can compare freely), a valid positive finite number is honoured, and anything else
// (negative, NaN, a non-numeric value that slipped through config) falls back to the default
// rather than silently disabling the cap and reopening the OOM.
export function getListFilesCap() {
  const n = config.listFilesCap
  if (n === 0 || n === Infinity) return Infinity
  if (typeof n === 'number' && Number.isFinite(n) && n > 0) return n
  return DEFAULT_LIST_FILES_CAP
}

// Same fail-safe contract as getListFilesCap: an explicit 0/Infinity disables the gate, a valid
// positive finite number is honoured, and anything else falls back to the default rather than
// silently letting an unbounded folder through.
export function getMaxFilesPerShare() {
  const n = config.maxFilesPerShare
  if (n === 0 || n === Infinity) return Infinity
  if (typeof n === 'number' && Number.isFinite(n) && n > 0) return n
  return DEFAULT_MAX_FILES_PER_SHARE
}

// Bytes per second, 0 = unlimited. The fail-safe polarity is INVERTED relative to
// getListFilesCap: those guard against resource exhaustion, so a bad value must keep the
// cap; this is a user convenience, so a bad value must return to unlimited rather than
// throttle every transfer to a crawl.
export function getBandwidthLimits() {
  const c = config
  return { download: toBytesPerSecond(c.downloadKBps), upload: toBytesPerSecond(c.uploadKBps) }
}

// The fail-safe contract of getListFilesCap with 0 read the other way round: this bounds
// worker memory, so 0 means "no cache" (never "no bound"), Infinity means unbounded, and a
// corrupt value falls back to the default rather than to either extreme.
export function getServeChunkMapCacheBytes() {
  const n = config.serveChunkMapCacheBytes
  if (n === 0 || n === Infinity) return n
  if (typeof n === 'number' && Number.isFinite(n) && n > 0) return n
  return DEFAULTED.serveChunkMapCacheBytes
}

function toBytesPerSecond(kbps) {
  if (typeof kbps !== 'number' || !Number.isFinite(kbps) || kbps <= 0) return 0
  return kbps * 1024
}

export function getCaptureMemberRecordMs() {
  return config.captureMemberRecordMs
}

export function getHandshakeRateLimit() {
  const c = config
  return {
    // burstPerTopic multiplies a per-socket count, so it is clamped to a finite non-negative
    // number: Infinity would make the product NaN for a peer with no matched topic yet and
    // silently switch the lane OFF, and a negative would drop every honest frame.
    matched: { burst: c.handshakeBurst, burstPerTopic: finiteAtLeast(c.handshakeBurstPerTopic, 0, DEFAULTED.handshakeBurstPerTopic), refillMs: c.handshakeRefillMs, abuseThreshold: c.handshakeAbuseThreshold },
    unmatched: { burst: c.handshakeUnmatchedBurst, refillMs: c.handshakeUnmatchedRefillMs, abuseThreshold: c.handshakeUnmatchedAbuseThreshold },
  }
}

export function getConvergenceConfig() {
  const c = config
  return {
    convergenceTickMs: c.convergenceTickMs,
    announceBaseMs: c.announceBaseMs,
    announceCapMs: c.announceCapMs,
    announceMaxAttempts: c.announceMaxAttempts,
    dupReciprocalFloorMs: c.dupReciprocalFloorMs,
    convergenceEscalateTicks: c.convergenceEscalateTicks,
    convergenceRefreshMinMs: c.convergenceRefreshMinMs,
    convergenceMaxEscalations: c.convergenceMaxEscalations,
  }
}

export function getIdentityFrameDropWindow() {
  const c = config
  return { after: c.testDropIdentityFramesAfter, count: c.testDropIdentityFramesCount }
}

export function getNetImpair() {
  return config.netImpair
}

export function getResourceCaps() {
  const c = config
  return {
    serverConnections: c.maxServerConnections,
    clientConnections: c.maxClientConnections,
    pendingRequesters: c.maxPendingRequesters,
    membersPerSpace: c.maxMembersPerSpace,
    approvalsPerMember: c.maxApprovalsPerMember,
    requestsPerMember: c.maxRequestsPerMember,
    invitesPerMember: c.maxInvitesPerMember,
    peerBeeCaptureMaxBlocks: c.peerBeeCaptureMaxBlocks,
    avatarMaxBytes: c.maxAvatarBytes,
    deriveDebounceMs: c.deriveDebounceMs,
    foreignPollIntervalMs: c.foreignPollIntervalMs,
  }
}
