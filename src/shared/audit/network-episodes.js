// Folds the connectivity verdict into audit rows. Pure and clock-injected — no store, no timers,
// no Date.now() — so the awkward cases (a flap inside the hold-down, a sleep, an outage spanning a
// restart) test without a Corestore or a swarm. Same split as peer-observer / peer-watch: the rules
// live here, the I/O lives in network-watch.js.
//
// Three rules:
//   1. UNKNOWN IS A NO-OP. It means boot, suspend, or a consensus still forming. A closed laptop
//      must not read as an outage, so it neither opens nor closes an episode.
//   2. HOLD DOWN BEFORE RECORDING, BOTH DIRECTIONS. stabilise() in reachability.js already dwells
//      before ESCALATING, but it deliberately exempts os-offline and dht-unreachable (the live UI
//      must react to a pulled cable instantly) and recovery is always immediate. Without a second
//      hold-down here, one Wi-Fi roam writes a degraded row and a restored row.
//   3. STANDING-STATE DEDUPE, DURABLY. The last kind we recorded is persisted by the caller, so
//      relaunching on the same bad network is silent.
import { VERDICT, CAUSE } from '../core/reachability.js'

// Every transient we do NOT want in the log settles well inside this: a Wi-Fi roam, a VPN
// reconnect, a sleep/wake re-association. Everything the log SHOULD carry outlives it.
export const EPISODE_DWELL_MS = 60000

export const KIND_OFFLINE = 'network.offline'
export const KIND_BLOCKED = 'network.blocked'
export const KIND_AT_RISK = 'network.at_risk'
export const KIND_RESTORED = 'network.restored'

// Two sentinels, deliberately distinct: 'healthy' is a REAL state (no episode is open), while null
// is "no opinion" and must not be compared against anything.
export const NO_EPISODE = 'healthy'
export const NO_OPINION = null

// The kind a (verdict, cause) pair belongs to — NOT one kind per cause. A cause that changes inside
// the same kind (dht-unreachable -> no-public-address, both blocked) is the same standing fact and
// must not write a second row. os-offline earns its own kind because "you are not on a network" and
// "this network blocks us" have different remedies, and the shipped ConnectionProblem copy already
// splits them.
export function kindFor(verdict, cause) {
  if (verdict === VERDICT.UNKNOWN) return NO_OPINION
  if (verdict === VERDICT.HEALTHY) return NO_EPISODE
  if (verdict === VERDICT.AT_RISK) return KIND_AT_RISK
  return cause === CAUSE.OS_OFFLINE ? KIND_OFFLINE : KIND_BLOCKED
}

// Chosen so a reader can tell the two blocked shapes apart months later: "found nobody" and "found
// peers, reached none" are the same kind and very different problems. Evidence is as of RECORDING,
// not as of the transition — the row's job is to be readable, not to be a time series.
export function evidenceFor(kind, evidence = {}) {
  if (kind === KIND_OFFLINE) {
    return { confidence: evidence.confidence ?? null, interfaceKind: evidence.interfaceKind ?? null }
  }
  if (kind === KIND_AT_RISK) {
    return { confidence: evidence.confidence ?? null, publicPort: evidence.publicPort ?? 0 }
  }
  if (kind === KIND_BLOCKED) {
    return {
      confidence: evidence.confidence ?? null,
      peersDiscovered: evidence.peersDiscovered ?? 0,
      peersExhausted: evidence.peersExhausted ?? 0,
    }
  }
  if (kind === KIND_RESTORED) {
    return { confidence: evidence.confidence ?? null, peersConnected: evidence.peersConnected ?? 0 }
  }
  return {}
}

function degradedRow(candidate) {
  return { kind: candidate.target, code: candidate.cause, subject: { sinceTs: candidate.since } }
}

function restoredRow(persisted, candidate, session) {
  // The duration is only honest when the outage began in THIS process. If it started before a
  // restart the app was closed for an unknown part of it, and an invented figure is worse than an
  // absent one — metaParts drops the part when durationMs is null.
  const sameSession = !!persisted?.session && persisted.session === session
  const startedAt = Number.isFinite(persisted?.since) ? persisted.since : null
  return {
    kind: KIND_RESTORED,
    code: persisted?.cause ?? null,
    subject: {
      // NOT `sinceTs`: this is when the connection came BACK, and the meta line renders sinceTs as
      // "started …" — which would date the outage to the moment it was fixed.
      recoveredTs: candidate.since,
      fromKind: persisted?.kind ?? null,
      durationMs: sameSession && startedAt !== null ? Math.max(0, candidate.since - startedAt) : null,
    },
  }
}

export function createEpisodeTracker({ dwellMs = EPISODE_DWELL_MS } = {}) {
  // Purely in-memory, and that is correct: a state not observed for `dwellMs` within ONE session
  // has not been observed.
  let candidate = null

  function pendingWait(now) {
    if (!candidate) return null
    return Math.max(0, dwellMs - (now - candidate.firstSeenAt))
  }

  // `persisted` is the last state we recorded: { kind, cause, since, session } | null.
  // Returns { row, next, waitMs }, where `next` is meaningful ONLY when `row` is non-null (null
  // then means "delete the key"). Gating it on `row` is what keeps "nothing changed" and "clear
  // it" from needing a third sentinel.
  function step({ verdict, cause = null, since = 0, now, session, persisted = null }) {
    const target = kindFor(verdict, cause)

    // The candidate is NOT cleared here: a blocked verdict that blips through `unknown` on its way
    // back to blocked keeps its hold-down running, which is the point of the hold-down.
    if (target === NO_OPINION) return { row: null, next: null, waitMs: pendingWait(now) }

    const recorded = persisted?.kind ?? NO_EPISODE

    if (target === recorded) {
      candidate = null
      return { row: null, next: null, waitMs: null }
    }

    if (!candidate || candidate.target !== target) {
      candidate = { target, cause, since: since || now, firstSeenAt: now }
    } else if (cause && candidate.cause !== cause) {
      candidate.cause = cause
    }

    const held = now - candidate.firstSeenAt
    if (held < dwellMs) return { row: null, next: null, waitMs: dwellMs - held }

    const row = target === NO_EPISODE
      ? restoredRow(persisted, candidate, session)
      : degradedRow(candidate)
    const next = target === NO_EPISODE
      ? null
      : { kind: target, cause: candidate.cause, since: candidate.since, session }

    candidate = null
    return { row, next, waitMs: null }
  }

  return {
    step,
    reset: () => { candidate = null },
    pending: () => (candidate ? { ...candidate } : null),
  }
}
