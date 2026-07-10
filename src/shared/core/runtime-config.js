const DEFAULT_PEER_READ_TIMEOUT_MS = 8000
// Upper bound on how long an approver waits to durably capture a joiner's own membership
// record at approval time (the joiner is connected then; see captureJoinerMembership).
// 0 disables the capture. Tests shrink it to exercise the timeout / disabled paths.
const DEFAULT_CAPTURE_MEMBER_RECORD_MS = 5000
const DEFAULT_LIST_FILES_CAP = 5000

// Single source of truth for every runtime-config field. Both the live default state and each
// setRuntimeConfig(next) call derive from these tables, so every default is declared exactly once.
// The coercion groups are kept distinct because their falsy-handling differs and must not drift:
//  NULLABLE — `next || null`: any falsy override (including '') collapses to null.
//  BOOLEAN — `!!next`: a strict boolean, default false.
//  DEFAULTED — `next ?? default`: nullish-only fallback, so a 0 / Infinity override is honored
//  (the "disable this cap" escape hatch).

// Paths / opaque strings; a falsy override means "unset". dhtBootstrap is test-only — a local
// hyperdht/testnet bootstrap so integration tests stay off the public DHT; null → default.
const NULLABLE = ['storage', 'appVersion', 'downloadFolder', 'dhtBootstrap']

// Dev toggles + feature flags, all default-off.
const BOOLEAN = [
  'dev', 'verbose',
  'membershipApprovalEnabled', 'handshakeIdentityBindingEnabled',
  'sharePrepareProgressEnabled',
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
  listFilesCap: DEFAULT_LIST_FILES_CAP,
  captureMemberRecordMs: DEFAULT_CAPTURE_MEMBER_RECORD_MS,
  deepReconcileEvery: 4,
  // Only topic-MATCHED identity frames charge this lane (the receiver resolves the topic
  // before charging), so the burst covers the spaces two peers actually share.
  handshakeBurst: 8,
  handshakeRefillMs: 1000,
  handshakeAbuseThreshold: 24,
  // Frames naming a topic we did not join: dropped before any signature verify, so the lane
  // can be generous (mirrors the overlay serve limiter). Bans only on a sustained flood.
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
  return out
}

let config = buildConfig()

export function setRuntimeConfig(next) {
  config = buildConfig(next)
}

export function setDownloadFolder(folder) {
  config = { ...config, downloadFolder: folder }
}

export function getRuntimeConfig() {
  return config
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

export function getOverlayServeLimit() {
  const c = config
  return { burst: c.overlayServeBurst, refillMs: c.overlayServeRefillMs, abuseThreshold: c.overlayServeAbuseThreshold }
}

export function getDeepReconcileEvery() {
  return config.deepReconcileEvery
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

export function getCaptureMemberRecordMs() {
  return config.captureMemberRecordMs
}

export function getHandshakeRateLimit() {
  const c = config
  return {
    matched: { burst: c.handshakeBurst, refillMs: c.handshakeRefillMs, abuseThreshold: c.handshakeAbuseThreshold },
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
