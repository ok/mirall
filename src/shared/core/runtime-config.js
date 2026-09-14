import { JOIN_REQUEST_FRAME_OVERHEAD } from '../contract/limits.js'
import { PUBLISH_ORDERS } from '../contract/paths.js'

export { PUBLISH_ORDERS }
const DEFAULT_PUBLISH_ORDER = 'smallest-first'

// The admission gate and the display ceiling are ONE number, not two that happen to match: a folder
// the gate ADMITS must always render in full. See listFilesCap / maxFilesPerShare below.
const DEFAULT_SHARE_FILE_LIMIT = 5000

// Single source of truth for every runtime-config field. Both the live default state and each
// setRuntimeConfig(next) call derive from these tables. The four coercion groups are kept distinct
// because their falsy-handling differs and must not drift:
//  NULLABLE — `next || null`: any falsy override (including '') collapses to null.
//  BOOLEAN — `!!next`: a strict boolean, default false.
//  DEFAULTED — `next ?? default`: nullish-only fallback, so a 0 / Infinity override is honored
//  (the "disable this cap" escape hatch).
//  DEFAULT_ON — `next?.x !== false`: only an explicit false disables.
//
// Validation is a SEPARATE table (RULES) applied when a getter READS, never when the config is
// built: setRuntimeConfig({ ...getRuntimeConfig(), x }) is the shape the live setters use, so
// buildConfig has to stay a no-op on its own output. The consequence is deliberate: getRuntimeConfig()
// hands back the raw override, while getListFilesCap() and its peers hand back the validated read.
// Reach for the getter unless you specifically want what the host sent.

// Paths / opaque strings; a falsy override means "unset".
const NULLABLE = ['storage', 'appVersion', 'downloadFolder', 'dhtBootstrap', 'upgradeKey']

// Dev toggles + feature flags, all default-off.
const BOOLEAN = [
  'dev', 'verbose',
  'handshakeIdentityBindingEnabled',
]

// Flags that ship ENABLED, so an absent or partial bootstrap frame can never silently degrade the
// app — only an explicit `false` disables one. Overlay is the only content backend, so off degrades
// every share to UNSUPPORTED. separateContentPlane off reverts to control + content on one stream.
// sharePrepareProgress off removes both the "preparing NN%" decoration and the liveness signal that
// keeps a download parked on a re-publish alive: a source that hashes for hours re-arms the
// receiver's wait with every frame, so the wait bounds SILENCE rather than the hash.
const DEFAULT_ON = [
  'overlayEnabled', 'inPlaceFilesEnabled', 'separateContentPlane', 'sharePrepareProgressEnabled',
]

// Numeric budgets / timeouts, mostly DoS / resource bounds: each caps how much work, memory,
// or wall-clock a remote peer (or a huge local folder) can make this process spend. A 0 or Infinity
// override is meaningful — usually "disable this cap" — so these fall back only on null/undefined.
//
// TEST LEVERS — keys production never sets, each defaulting to "off"; tests set them for a
// deterministic reproduction: dhtBootstrap (local testnet), peerReadTimeoutMs (a shrunk read
// budget), testDropIdentityFramesAfter/Count (lossy link), testTruncatePeerDrainAfter (truncated
// listing), netImpair (shaped connections), peerPresenceDwellMs (absence dwell). Every other key
// is merely shrunk by tests and has a production default.
const DEFAULTED = {
  peerReadTimeoutMs: 8000,
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
  listFilesCap: DEFAULT_SHARE_FILE_LIMIT,
  // Max files in a folder a user may SHARE — an admission gate enforced at add-folder time
  // (and in the worker), NOT a runtime ceiling: an already-shared folder that GROWS past this
  // keeps publishing, because silently refusing to publish would leave the folder incomplete on
  // every peer — a far worse failure than a truncated list. Growth surfaces a warning instead,
  // and the gate never fires on remount/relocate/reconcile. 0 / Infinity disables it.
  maxFilesPerShare: DEFAULT_SHARE_FILE_LIMIT,
  // Upper bound on how long an approver waits to durably capture a joiner's own membership
  // record at approval time (the joiner is connected then; see captureJoinerMembership).
  // 0 disables the capture. Tests shrink it to exercise the timeout / disabled paths.
  captureMemberRecordMs: 5000,
  deepReconcileEvery: 4,
  // Owner-side publish slots across all spaces. Hashing is synchronous CPU on the worker thread;
  // 2 overlaps one file's reads with another's hashing, beyond that gains nothing. The scheduler
  // clamps to >= 1.
  publishConcurrency: 2,
  // Concurrent overlay downloads across the WHOLE process — both engines and every mirror draw on
  // one gate. A reconnect can have hundreds of pending rows and each running fetch owns a chunk
  // scheduler, a watchdog, an fd and a progress ticker. 6 = two engines' former 3 each, now one
  // gate that also counts the mirrors. 0 disables the gate.
  downloadConcurrency: 6,
  // Open peer catalogs kept cached. Each is a Hyperbee + Hypercore session with an append listener,
  // and every open core replicates to every socket. 0 = unbounded.
  peerCatalogCacheLimit: 64,
  // Mirror deletion plausibility gate. The owner-online / non-empty / complete-listing gates
  // establish that a listing is authoritative, not that it is plausible: a share shrinking 1000 ->
  // 3 passed all three and unlinked 997 local files. Always honour up to `min` deletions so
  // ordinary tidying is unaffected; above that never more than `ratio` of what the mirror owns.
  minMirrorDeletions: 8,
  maxMirrorDeletionRatio: 0.5,
  // Boot leftover-sweep plausibility cap. The sweep deletes cores irreversibly, so an implausibly
  // large target set is treated as evidence the classification is wrong, not as work to do. Always
  // allow `min`; above that never more than `ratio` of the store, and never more than `max`.
  minSweepPurgeCores: 8,
  maxSweepPurgeCores: 64,
  maxSweepPurgeRatio: 0.5,
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
  // Drop inbound identity frames with 0-based index in [after, after+count). count 0 = off.
  testDropIdentityFramesAfter: 0,
  testDropIdentityFramesCount: 0,
  // Stop a peer-catalog drain after this many entries and report the read INCOMPLETE, so the
  // mirror-deletion guard can be exercised without racing a real drain timeout. 0 = off.
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
  // balloon memory or the renderer. Keep in sync with AVATAR_MAX_BYTES in contract/limits.js
  // (a unit test asserts they match). 0 disables it.
  maxAvatarBytes: 256 * 1024,
  deriveDebounceMs: 150,
  // Serve-side cache of DECODED chunk maps, in bytes (~160 B per chunk entry), so a chunk-need does
  // not re-read and JSON-decode the file's whole map from the file-index bee per chunk served.
  // 32 MiB holds ~200k entries: twenty concurrent 10 GiB tier-3 serves or two 100 GiB ones; a
  // single larger map is still admitted (the cache keeps its newest entry). 0 disables the cache;
  // Infinity unbounds it.
  serveChunkMapCacheBytes: 32 * 1024 * 1024,
  // Foreign-mirror materialize poll cadence. Tests shrink it to assert orphan-mount teardown
  // (owner left → unmount) promptly; production uses the 30s default.
  foreignPollIntervalMs: 30_000,
  // How often the supervisor asks every subsystem whether its units are still advancing. 60s
  // matches the cadence the mirror probe ran at, so the two-consecutive-bad rule still acts about
  // two minutes into a stall. Tests shrink it.
  supervisionProbeIntervalMs: 60_000,
  // How long a recover() may run before the supervisor stops waiting on it. Generous against every
  // recovery in the tree (each re-arms a loop and returns) and short against the probe interval, so
  // one slow recovery cannot eat the next probe.
  supervisionRecoverBudgetMs: 10_000,
  // A diff over a large tree is legitimately slow, so the wedge signal is a pass that stats no
  // file for this long — not one that merely takes a while. Generous on purpose: a false recovery
  // costs a re-scan, and by the time it fires the share has made no progress for ten minutes.
  reconcileStallWindowMs: 10 * 60 * 1000,
  // A publish item that has hashed no byte and completed no phase for this long is wedged, not
  // slow — the same window as reconcileStallWindowMs, for the same reason.
  publishStallWindowMs: 10 * 60 * 1000,
  // The convergence tick's own window, rather than a multiple of its interval: its phases are
  // network-bound — a per-space bee read per pending announce, then a discovery refresh per space
  // on both planes — and a tight multiple of a 15s cadence condemns a tick that is slow because
  // the network is, which is exactly when the re-drive matters most. Every phase beats, so a tick
  // silent for five minutes has stopped.
  convergenceStallWindowMs: 5 * 60 * 1000,
  // How many mirror ticks may skip the walk before one runs in full regardless. The owner's catalog
  // version cannot see a LOCAL change (a user deleting a mirrored file) and a foreign mount has no
  // filesystem watcher, so this backstop is what repairs it — within 5 min at the 30s poll.
  // 1 disables the skip entirely: the rollback, settable in a shipped build via
  // MIRALL_FOREIGN_FULL_WALK_EVERY, which the host forwards on the bootstrap frame.
  foreignFullWalkEvery: 10,
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
  // Shape THIS peer's swarm connections (applied per connection in swarm.js, applyNetImpairment).
  // null = off. Shape:
  //   { latencyMs, jitterMs }       delay every outbound frame (models RTT / loss-retransmit)
  //   { flapEveryMs, flapJitterMs }  periodically destroy each live connection (a flaky link →
  //                                  reconnect churn, handshake re-rate-limiting, state re-sync)
  netImpair: null,
  // User-facing content-plane transfer caps, KB/s, 0 = unlimited (the default). Unlike the
  // protective bounds above these fail OPEN — see getBandwidthLimits.
  downloadKBps: 0,
  uploadKBps: 0,
  // How long a peer must be unreachable before the audit log records the absence. 0 = use
  // peer-episodes.js's own default (production).
  peerPresenceDwellMs: 0,
}

// --- Validation rules -------------------------------------------------------------------------
// Six rules, applied by read() when a getter asks for a key. Each takes the raw override, the key's
// tabled default and an optional bound, and returns a value the caller may act on. A rule never
// throws and never returns undefined: the alternative is a worker that dies on a malformed
// bootstrap frame.

function isFiniteAtLeast(value, min) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min
}

function isPositiveFinite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

// A budget that is multiplied by a live count, or divided into an elapsed time, must be finite and
// within its bound: Infinity yields NaN against a zero count (which reads as "lane disabled" and
// fails OPEN), a negative yields a cap no frame can meet (fails closed on honest peers).
function finiteAtLeast(value, fallback, min) {
  return isFiniteAtLeast(value, min) ? value : fallback
}

// A slot count: the same admission, floored, because a fractional slot is not one.
function intAtLeast(value, fallback, min) {
  return isFiniteAtLeast(value, min) ? Math.floor(value) : fallback
}

// intAtLeast with an explicit Infinity honoured as "unbounded". The asymmetry with intAtLeast is the
// whole reason these are two rules rather than one with two minima: on the publish lane Infinity
// means "run every item at once", while on the download gate 0 already means that — so an Infinity
// there is a malformed value, and admitting it would quietly unbound the gate.
function intAtLeastOrInfinity(value, fallback, min) {
  return value === Infinity ? Infinity : intAtLeast(value, fallback, min)
}

// A protective bound that fails SAFE: an explicit 0 or Infinity disables the cap (returned as
// Infinity so callers can compare freely), a positive finite number is honoured, and anything else
// falls back to the default rather than silently disabling the cap.
function capOrInfinity(value, fallback) {
  if (value === 0 || value === Infinity) return Infinity
  return isPositiveFinite(value) ? value : fallback
}

// capOrInfinity with the two sentinels kept DISTINCT: this bounds worker memory, so 0 means "no
// cache" and never "no bound", and Infinity means unbounded. A corrupt value falls back to the
// default rather than to either extreme.
function boundedOrSentinel(value, fallback) {
  if (value === 0 || value === Infinity) return value
  return isPositiveFinite(value) ? value : fallback
}

// The inverted polarity: a user convenience rather than a protective bound, so a corrupt value
// returns to UNLIMITED (0) instead of throttling every transfer to a crawl. The tabled default is
// deliberately not consulted.
function failOpen(value) {
  return isPositiveFinite(value) ? value : 0
}

// Which rule validates which key. A key ABSENT here is read raw — that is 43 of the 63 DEFAULTED
// keys, including every getResourceCaps cell and the burst and threshold of every rate-limited lane.
// Absence is not an oversight to tidy up: giving one of those keys a rule CHANGES A DOS BOUND or a
// user-facing cap, so it is a deliberate change that needs the behaviour test to prove it.
const RULES = {
  // Deadlines, where both DEFAULTED sentinels invert: 0 makes stallVerdict condemn every pass the
  // instant it starts, so the supervisor evicts every healthy publish and abandons every healthy
  // scan; Infinity reaches setTimeout, which clamps it to about a millisecond, so "no timeout"
  // becomes "instant timeout".
  supervisionRecoverBudgetMs: { rule: finiteAtLeast, min: 1 },
  reconcileStallWindowMs: { rule: finiteAtLeast, min: 1 },
  publishStallWindowMs: { rule: finiteAtLeast, min: 1 },
  convergenceStallWindowMs: { rule: finiteAtLeast, min: 1 },

  // Every refill interval is a DIVISOR — take() decays a bucket by (elapsed / refillMs) — so a 0
  // makes the first take compute 0/0, and NaN never exceeds the cap: the lane then admits every
  // frame forever. A limiter that fails OPEN is the one direction a limiter must never fail, which
  // is why all four lanes carry this rule while their bursts and thresholds (which fail closed,
  // loudly) do not.
  peerFrameRefillMs: { rule: finiteAtLeast, min: 1 },
  handshakeRefillMs: { rule: finiteAtLeast, min: 1 },
  handshakeUnmatchedRefillMs: { rule: finiteAtLeast, min: 1 },
  overlayServeRefillMs: { rule: finiteAtLeast, min: 1 },

  // A 0 threshold bans on the first drop.
  peerFrameAbuseThreshold: { rule: finiteAtLeast, min: 1 },

  // Lane budgets whose 0 is the documented "switch it off" override.
  peerFrameBurst: { rule: finiteAtLeast, min: 0 },
  peerFrameMaxBytes: { rule: finiteAtLeast, min: 0 },
  peerCatalogCacheLimit: { rule: finiteAtLeast, min: 0 },
  handshakeBurstPerTopic: { rule: finiteAtLeast, min: 0 },

  publishConcurrency: { rule: intAtLeastOrInfinity, min: 1 },
  downloadConcurrency: { rule: intAtLeast, min: 0 },

  listFilesCap: { rule: capOrInfinity },
  maxFilesPerShare: { rule: capOrInfinity },

  serveChunkMapCacheBytes: { rule: boundedOrSentinel },

  downloadKBps: { rule: failOpen },
  uploadKBps: { rule: failOpen },
}

// The one read path. A key with no rule resolves to its raw override, so routing every getter
// through here means attaching a rule later is one table row rather than an edit inside a getter.
function read(key) {
  const spec = RULES[key]
  return spec ? spec.rule(config[key], DEFAULTED[key], spec.min) : config[key]
}

// test seam — the rule table is the thing a reader is most likely to "complete" by filling in a
// blank, and every blank is a DoS bound or a user cap. runtime-config-rules.test.js pins the set.
export function _rulesForTests() {
  return {
    ruled: Object.fromEntries(Object.entries(RULES).map(([k, v]) => [k, { rule: v.rule.name, min: v.min }])),
    defaultedKeys: Object.keys(DEFAULTED).length,
  }
}

// --- Coercers ---------------------------------------------------------------------------------

function coercePublishOrder(order) {
  return PUBLISH_ORDERS.includes(order) ? order : DEFAULT_PUBLISH_ORDER
}

// 'off' is the default and the kill switch: relayFunctionFor returns null for it, so
// swarm.relayThrough is never installed and the transport is byte-identical to a build with no
// relay support. Both the bootstrap frame and the live setter coerce through here, because a mode
// one admits and the other rejects would not survive a restart.
function coerceRelayMode(mode) {
  return mode === 'auto' || mode === 'always' ? mode : 'off'
}

// The public half of the relay slot only. The member seed is deliberately absent from
// runtime config: it rides the bootstrap frame and is consumed in boot.js, exactly as
// bootstrap.identityKEK is, so it never reaches a getRuntimeConfig() caller.
function coerceRelaySlot(relay) {
  if (!relay || typeof relay !== 'object' || Array.isArray(relay)) return null
  return relay
}

function buildConfig(next) {
  const out = {}
  for (const k of NULLABLE) out[k] = next?.[k] || null
  for (const k of BOOLEAN) out[k] = !!next?.[k]
  for (const k of Object.keys(DEFAULTED)) out[k] = next?.[k] ?? DEFAULTED[k]
  for (const k of DEFAULT_ON) out[k] = next?.[k] !== false
  out.relayMode = coerceRelayMode(next?.relayMode)
  out.relay = coerceRelaySlot(next?.relay)
  out.publishOrder = coercePublishOrder(next?.publishOrder)
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

// A partial update, so its fallback is the LIVE value rather than the tabled default: omitting a
// direction, or sending a corrupt one, leaves that direction's cap where the user last set it.
function coerceKBps(next, fallback) {
  if (next === undefined || next === null) return fallback
  return typeof next === 'number' && Number.isFinite(next) && next >= 0 ? next : fallback
}

// The raw overrides, uncoerced. See the header: the getters below are what a caller acting on a
// value should use.
export function getRuntimeConfig() {
  return config
}

export function getPeerPresenceDwellMs() {
  return read('peerPresenceDwellMs')
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

export function getRelayConfig() {
  return { mode: config.relayMode, relay: config.relay }
}

export function setRelayConfig(mode, relay) {
  config = { ...config, relayMode: coerceRelayMode(mode), relay: coerceRelaySlot(relay) }
}

export function getOverlayServeLimit() {
  return {
    burst: read('overlayServeBurst'),
    refillMs: read('overlayServeRefillMs'),
    abuseThreshold: read('overlayServeAbuseThreshold'),
  }
}

export function getDeepReconcileEvery() {
  return read('deepReconcileEvery')
}

export function getSupervisionProbeIntervalMs() {
  return read('supervisionProbeIntervalMs')
}

export function getSupervisionRecoverBudgetMs() {
  return read('supervisionRecoverBudgetMs')
}

export function getReconcileStallWindowMs() {
  return read('reconcileStallWindowMs')
}

export function getPublishStallWindowMs() {
  return read('publishStallWindowMs')
}

export function getConvergenceStallWindowMs() {
  return read('convergenceStallWindowMs')
}

export function getPublishConcurrency() {
  return read('publishConcurrency')
}

export function getDownloadConcurrency() {
  return read('downloadConcurrency')
}

export function getPeerFrameMaxBytes() {
  return read('peerFrameMaxBytes')
}

// The avatar budget for an avatar that travels INLINE in a peer frame, which is a different
// question from what may be stored at rest: the receiver charges the whole frame against
// peerFrameMaxBytes before it parses it, so an avatar sized by avatarMaxBytes (4x larger) makes
// the frame carrying it disappear unread. Never returns 0 while the frame cap is on —
// sanitizeAvatar reads 0 as "no size bound", so a budget eaten entirely by the overhead clamps to
// 1 byte, which is below the shortest possible data URI and therefore admits nothing.
export function joinRequestAvatarMaxBytes() {
  const frameMax = getPeerFrameMaxBytes()
  if (frameMax === 0) return getResourceCaps().avatarMaxBytes
  return Math.max(1, frameMax - JOIN_REQUEST_FRAME_OVERHEAD)
}

export function getPeerFrameLimits() {
  return {
    burst: read('peerFrameBurst'),
    refillMs: read('peerFrameRefillMs'),
    abuseThreshold: read('peerFrameAbuseThreshold'),
  }
}

export function getPeerCatalogCacheLimit() {
  return read('peerCatalogCacheLimit')
}

export function getPublishOrder() {
  return read('publishOrder')
}

export function getListFilesCap() {
  return read('listFilesCap')
}

export function getMaxFilesPerShare() {
  return read('maxFilesPerShare')
}

// KB/s on the wire, bytes/s to callers: the rule validates, the getter converts.
export function getBandwidthLimits() {
  return { download: read('downloadKBps') * 1024, upload: read('uploadKBps') * 1024 }
}

export function getServeChunkMapCacheBytes() {
  return read('serveChunkMapCacheBytes')
}

export function getCaptureMemberRecordMs() {
  return read('captureMemberRecordMs')
}

export function getHandshakeRateLimit() {
  return {
    matched: {
      burst: read('handshakeBurst'),
      burstPerTopic: read('handshakeBurstPerTopic'),
      refillMs: read('handshakeRefillMs'),
      abuseThreshold: read('handshakeAbuseThreshold'),
    },
    unmatched: {
      burst: read('handshakeUnmatchedBurst'),
      refillMs: read('handshakeUnmatchedRefillMs'),
      abuseThreshold: read('handshakeUnmatchedAbuseThreshold'),
    },
  }
}

export function getConvergenceConfig() {
  return {
    convergenceTickMs: read('convergenceTickMs'),
    announceBaseMs: read('announceBaseMs'),
    announceCapMs: read('announceCapMs'),
    announceMaxAttempts: read('announceMaxAttempts'),
    dupReciprocalFloorMs: read('dupReciprocalFloorMs'),
    convergenceEscalateTicks: read('convergenceEscalateTicks'),
    convergenceRefreshMinMs: read('convergenceRefreshMinMs'),
    convergenceMaxEscalations: read('convergenceMaxEscalations'),
  }
}

export function getIdentityFrameDropWindow() {
  return { after: read('testDropIdentityFramesAfter'), count: read('testDropIdentityFramesCount') }
}

export function getNetImpair() {
  return read('netImpair')
}

export function getResourceCaps() {
  return {
    serverConnections: read('maxServerConnections'),
    clientConnections: read('maxClientConnections'),
    pendingRequesters: read('maxPendingRequesters'),
    membersPerSpace: read('maxMembersPerSpace'),
    approvalsPerMember: read('maxApprovalsPerMember'),
    requestsPerMember: read('maxRequestsPerMember'),
    invitesPerMember: read('maxInvitesPerMember'),
    peerBeeCaptureMaxBlocks: read('peerBeeCaptureMaxBlocks'),
    avatarMaxBytes: read('maxAvatarBytes'),
    deriveDebounceMs: read('deriveDebounceMs'),
    foreignPollIntervalMs: read('foreignPollIntervalMs'),
    minMirrorDeletions: read('minMirrorDeletions'),
    maxMirrorDeletionRatio: read('maxMirrorDeletionRatio'),
    minSweepPurgeCores: read('minSweepPurgeCores'),
    maxSweepPurgeCores: read('maxSweepPurgeCores'),
    maxSweepPurgeRatio: read('maxSweepPurgeRatio'),
    foreignFullWalkEvery: read('foreignFullWalkEvery'),
  }
}
