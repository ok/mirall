import { PUBLISH_ORDERS } from '../contract/paths.js'
import {
  finiteAtLeast, intAtLeast, intAtLeastOrInfinity, capOrInfinity, boundedOrSentinel, failOpen,
} from './runtime-config-rules.js'

// Every runtime-config key, its default and (where it carries one) its validation rule. The live
// state and each setRuntimeConfig(next) call derive from these tables through buildConfig. The four
// coercion groups are kept distinct because their falsy-handling differs and must not drift:
//  NULLABLE — `next || null`: any falsy override (including '') collapses to null.
//  BOOLEAN — `!!next`: a strict boolean, default false.
//  DEFAULTED — `next ?? default`: nullish-only fallback, so a 0 / Infinity override is honored
//  (the "disable this cap" escape hatch).
//  DEFAULT_ON — `next?.x !== false`: only an explicit false disables.

const DEFAULT_PUBLISH_ORDER = 'smallest-first'

// The admission gate and the display ceiling are ONE number, not two that happen to match: a folder
// the gate ADMITS must always render in full. See listFilesCap / maxFilesPerShare below.
const DEFAULT_SHARE_FILE_LIMIT = 5000

// A DEFAULTED row that a getter validates on read. Most rows carry no rule and are read raw —
// including every connection, membership and sweep cap and the burst and threshold of every
// rate-limited lane. Giving one of those a rule CHANGES A DOS BOUND or a user-facing cap, so it is
// a deliberate change that needs the behaviour test to prove it.
function ruled(fallback, rule, min) {
  return { fallback, rule, min }
}

function isRuled(row) {
  return typeof row === 'object' && row !== null && typeof row.rule === 'function'
}

// Paths / opaque strings; a falsy override means "unset". dhtBootstrap is a test lever (a local
// testnet instead of the public DHT); production never sets it.
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

// Keys production never sets, each defaulting to "off"; tests set them for a deterministic
// reproduction.
const TEST_LEVERS = {
  // Drop inbound identity frames with 0-based index in [after, after+count). count 0 = off.
  testDropIdentityFramesAfter: 0,
  testDropIdentityFramesCount: 0,
  // Stop a peer-catalog drain after this many entries and report the read INCOMPLETE, so the
  // mirror-deletion guard can be exercised without racing a real drain timeout. 0 = off.
  testTruncatePeerDrainAfter: 0,
  // Shape THIS peer's swarm connections (applied per connection in swarm.js, applyNetImpairment).
  // null = off. Shape:
  //   { latencyMs, jitterMs }       delay every outbound frame (models RTT / loss-retransmit)
  //   { flapEveryMs, flapJitterMs }  periodically destroy each live connection (a flaky link →
  //                                  reconnect churn, handshake re-rate-limiting, state re-sync)
  netImpair: null,
  // How long a peer must be unreachable before the audit log records the absence. 0 = use
  // presence-episodes.js's own default (production).
  peerPresenceDwellMs: 0,
}

// Numeric budgets / timeouts, mostly DoS / resource bounds: each caps how much work, memory,
// or wall-clock a remote peer (or a huge local folder) can make this process spend. A 0 or Infinity
// override is meaningful — usually "disable this cap" — so these fall back only on null/undefined.
// Tests shrink most of them.
const DEFAULTED = {
  peerReadTimeoutMs: 8000,
  // How long a connection must stay relayed before the audit log records it.
  relayAuditDwellMs: 10000,
  // Read budget for the INTERACTIVE list fan-outs (files:list / share:list). Much shorter than
  // peerReadTimeoutMs so a not-yet-replicated member can't freeze the list — it returns the
  // locally-available rows now and self-heals: event:shares-updated / event:files-updated re-run
  // the listing once that peer's bee appends. The full peerReadTimeoutMs stays reserved for
  // correctness-critical reads (mirror / foreign-folder). A 0 override is honored.
  interactiveReadTimeoutMs: 1500,
  // One deadline for the whole approval gate, shared by every member read it runs in parallel.
  // Shorter than peerReadTimeoutMs because a "no" is retried: the joiner's unsettled handshake is
  // re-sent by the convergence tick, an approver's bee append re-runs the gate for pending
  // requesters, and a fold that lists the joiner as a member readmits its live connection.
  admissionReadTimeoutMs: ruled(4000, finiteAtLeast, 1),
  // Upper bound on how many file rows share:list-files materialises + ships in one IPC
  // frame. A folder with 150k files would otherwise build a ~150k-row array (+ a giant
  // JSON.stringify) per read and render every row un-virtualised → the worker hits V8's
  // ~4GB ceiling and dies ("huge folder freezes the app"). Past the cap the renderer
  // shows "first N of M" (the true total is streamed separately). 0 / Infinity disables.
  //
  // RAISING THIS REQUIRES VIRTUALISING THE FILE LIST FIRST. The number is not a policy
  // choice — it is the bound that keeps an un-windowed list renderable. maxFilesPerShare
  // is held equal to it so a folder we ADMIT always renders in full.
  listFilesCap: ruled(DEFAULT_SHARE_FILE_LIMIT, capOrInfinity),
  // Max files in a folder a user may SHARE — an admission gate enforced at add-folder time
  // (and in the worker), NOT a runtime ceiling: an already-shared folder that GROWS past this
  // keeps publishing, because silently refusing to publish would leave the folder incomplete on
  // every peer — a far worse failure than a truncated list. Growth surfaces a warning instead,
  // and the gate never fires on remount/relocate/reconcile. 0 / Infinity disables it.
  maxFilesPerShare: ruled(DEFAULT_SHARE_FILE_LIMIT, capOrInfinity),
  // Upper bound on how long an approver waits to durably capture a joiner's own membership
  // record at approval time (the joiner is connected then; see captureJoinerMembership).
  // 0 disables the capture. Tests shrink it to exercise the timeout / disabled paths.
  captureMemberRecordMs: 5000,
  deepReconcileEvery: 4,
  // Owner-side publish slots across all spaces. Hashing is synchronous CPU on the worker thread;
  // 2 overlaps one file's reads with another's hashing, beyond that gains nothing. Infinity runs
  // every item at once; the scheduler clamps to >= 1.
  publishConcurrency: ruled(2, intAtLeastOrInfinity, 1),
  // Concurrent overlay downloads across the WHOLE process — both engines and every mirror draw on
  // one gate. A reconnect can have hundreds of pending rows and each running fetch owns a chunk
  // scheduler, a watchdog, an fd and a progress ticker. 6 = two engines' former 3 each, now one
  // gate that also counts the mirrors. 0 disables the gate, so an Infinity is malformed here.
  downloadConcurrency: ruled(6, intAtLeast, 0),
  // Open peer catalogs kept cached. Each is a Hyperbee + Hypercore session with an append listener,
  // and every open core replicates to every socket. 0 = unbounded.
  peerCatalogCacheLimit: ruled(64, finiteAtLeast, 0),
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
  //
  // Every refill interval is a DIVISOR — take() decays a bucket by (elapsed / refillMs) — so a 0
  // makes the first take compute 0/0, and NaN never exceeds the cap: the lane then admits every
  // frame forever. A limiter that fails OPEN is the one direction a limiter must never fail, which
  // is why every lane's refill carries a rule while its burst and threshold (which fail closed,
  // loudly) do not. burstPerTopic multiplies a live count, so it is bounded for the same reason.
  handshakeBurst: 8,
  handshakeBurstPerTopic: ruled(3, finiteAtLeast, 0),
  handshakeRefillMs: ruled(1000, finiteAtLeast, 1),
  handshakeAbuseThreshold: 24,
  // Frames naming a topic we did not join: dropped before any signature verify, so the lane
  // can be generous (mirrors the overlay serve limiter). Bans only on a sustained flood.
  // Every peer frame is metered on a general lane, not just the two identity types. Presence is
  // the busiest honest source at one frame per (peer, space) per 5 s, so 256/20ms leaves an order
  // of magnitude of headroom. peerFrameBurst 0 switches the lane off; peerFrameMaxBytes 0 the cap.
  // A 0 threshold bans on the first drop.
  peerFrameMaxBytes: ruled(65536, finiteAtLeast, 0),
  peerFrameBurst: ruled(256, finiteAtLeast, 0),
  peerFrameRefillMs: ruled(20, finiteAtLeast, 1),
  peerFrameAbuseThreshold: ruled(512, finiteAtLeast, 1),
  handshakeUnmatchedBurst: 32,
  handshakeUnmatchedRefillMs: ruled(250, finiteAtLeast, 1),
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
  serveChunkMapCacheBytes: ruled(32 * 1024 * 1024, boundedOrSentinel),
  // Foreign-mirror materialize poll cadence. Tests shrink it to assert orphan-mount teardown
  // (owner left → unmount) promptly; production uses the 30s default.
  foreignPollIntervalMs: 30_000,
  // How often the supervisor asks every subsystem whether its units are still advancing. 60s
  // matches the cadence the mirror probe ran at, so the two-consecutive-bad rule still acts about
  // two minutes into a stall. Tests shrink it.
  supervisionProbeIntervalMs: 60_000,
  // Deadlines, where both DEFAULTED sentinels invert: 0 makes stallVerdict condemn every pass the
  // instant it starts, so the supervisor evicts every healthy publish and abandons every healthy
  // scan; Infinity reaches setTimeout, which clamps it to about a millisecond, so "no timeout"
  // becomes "instant timeout". Each of the four is bounded finite and positive.
  //
  // How long a recover() may run before the supervisor stops waiting on it. Generous against every
  // recovery in the tree (each re-arms a loop and returns) and short against the probe interval, so
  // one slow recovery cannot eat the next probe.
  supervisionRecoverBudgetMs: ruled(10_000, finiteAtLeast, 1),
  // A diff over a large tree is legitimately slow, so the wedge signal is a pass that stats no
  // file for this long — not one that merely takes a while. Generous on purpose: a false recovery
  // costs a re-scan, and by the time it fires the share has made no progress for ten minutes.
  reconcileStallWindowMs: ruled(10 * 60 * 1000, finiteAtLeast, 1),
  // A publish item that has hashed no byte and completed no phase for this long is wedged, not
  // slow — the same window as reconcileStallWindowMs, for the same reason.
  publishStallWindowMs: ruled(10 * 60 * 1000, finiteAtLeast, 1),
  // The convergence tick's own window, rather than a multiple of its interval: its phases are
  // network-bound — a per-space bee read per pending announce, then a discovery refresh per space
  // on both planes — and a tight multiple of a 15s cadence condemns a tick that is slow because
  // the network is, which is exactly when the re-drive matters most. Every phase beats, so a tick
  // silent for five minutes has stopped.
  convergenceStallWindowMs: ruled(5 * 60 * 1000, finiteAtLeast, 1),
  // How many mirror ticks may skip the walk before one runs in full regardless. The owner's catalog
  // version cannot see a LOCAL change (a user editing or deleting a mirrored file); the mirror's
  // watcher asks for a walk when it sees one, and this backstop repairs what the watcher missed —
  // a dropped event, a watcher stopped by an error storm — within 5 min at the 30s poll.
  // 1 disables the skip entirely: the rollback, settable in a shipped build via
  // MIRALL_FOREIGN_FULL_WALK_EVERY, which the host forwards on the bootstrap frame.
  foreignFullWalkEvery: 10,
  // Every Nth listing that consults a member's memoised loose catalog reads it anyway (the N-1
  // between are served from the memo; the storage summary lists through the same path and counts
  // too). The catalog version only moves while that catalog replicates, and this backstop re-syncs
  // its head under a steady stream of pokes without costing a quiet space anything. 1 disables the
  // skip: the rollback, settable in a shipped build via MIRALL_LIST_FULL_READ_EVERY, which the host
  // forwards on the bootstrap frame.
  listFullReadEvery: 10,
  // Per-requester rate limit on the overlay serve gate (inbound content-requests),
  // keyed on the asker's authenticated profile key. More
  // generous than the handshake limiter — a legit consumer issues one request
  // per file when syncing a folder. 0 burst disables it. Tests shrink them.
  overlayServeBurst: 32,
  overlayServeRefillMs: ruled(250, finiteAtLeast, 1),
  overlayServeAbuseThreshold: 256,
  // Owner-side catalog write batching during a folder scan: flush the buffered
  // advertise/setHash/tombstone ops on whichever comes first. Coarser, atomic heads
  // → smoother, consistent propagation to browsing peers. Tests shrink them.
  catalogFlushMs: 2500,
  catalogFlushMaxOps: 256,
  // User-facing content-plane transfer caps, KB/s, 0 = unlimited (the default). Unlike the
  // protective bounds above these fail OPEN — see getBandwidthLimits.
  downloadKBps: ruled(0, failOpen),
  uploadKBps: ruled(0, failOpen),
  ...TEST_LEVERS,
}

export function defaultOf(key) {
  const row = DEFAULTED[key]
  return isRuled(row) ? row.fallback : row
}

export function ruleOf(key) {
  const row = DEFAULTED[key]
  return isRuled(row) ? { rule: row.rule, min: row.min } : null
}

export function tabledKeys() {
  return Object.keys(DEFAULTED)
}

function coercePublishOrder(order) {
  return PUBLISH_ORDERS.includes(order) ? order : DEFAULT_PUBLISH_ORDER
}

// 'off' is the default and the kill switch: relayFunctionFor returns null for it, so
// swarm.relayThrough is never installed and the transport is byte-identical to a build with no
// relay support.
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

// A no-op on its own output: the live setters re-ingest the built config with one key changed.
export function buildConfig(next) {
  const out = {}
  for (const k of NULLABLE) out[k] = next?.[k] || null
  for (const k of BOOLEAN) out[k] = !!next?.[k]
  for (const k of tabledKeys()) out[k] = next?.[k] ?? defaultOf(k)
  for (const k of DEFAULT_ON) out[k] = next?.[k] !== false
  out.relayMode = coerceRelayMode(next?.relayMode)
  out.relay = coerceRelaySlot(next?.relay)
  out.publishOrder = coercePublishOrder(next?.publishOrder)
  return out
}
