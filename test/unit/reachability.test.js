import test from 'brittle'
import {
  classify, stabilise, hasRoutableAddress, routableAddressKind, VERDICT, CAUSE, CONFIDENCE, CANARY,
  NAT_SETTLE_MS, BLOCKED_DWELL_MS, LIVENESS_FAILURES_FOR_OFFLINE,
} from '../../src/shared/core/reachability.js'

const BASE = {
  now: 100000,
  bootedAt: 1000,
  readyAt: 4000,
  dhtReady: true,
  suspended: false,
  browserOnline: true,
  address: { publicHost: '203.0.113.7', publicPort: 41234 },
  routing: { tableSize: 50 },
  dhtHealth: { online: true, degraded: false, cold: false, idle: false },
  peerReach: { discovered: 0, connected: 0, exhausted: 0 },
  dials: { attempted: 0, opened: 0 },
  canary: { state: CANARY.UNAVAILABLE },
  liveness: { failures: 0, checkedAt: 0 },
  hasInterface: true,
  interfaceKind: 'physical',
}

const on = (over = {}) => ({ ...BASE, ...over })

test('healthy: stable mapping, nothing else wrong', (t) => {
  const r = classify(on())
  t.is(r.verdict, VERDICT.HEALTHY)
  t.is(r.cause, null)
})

test("REGRESSION (FIX-1: dhtReady is not connectivity) — the reported snapshot is not healthy", (t) => {
  // The 2026-08-21 report: DHT up, 50 routing entries, public IP known, public port 0
  // (symmetric NAT), no peers. The shipped UI called this "Netzwerk funktioniert".
  const r = classify(on({ address: { publicHost: '203.0.113.7', publicPort: 0 } }))
  t.is(r.verdict, VERDICT.AT_RISK)
  t.is(r.cause, CAUSE.SYMMETRIC_NAT)
  t.not(r.verdict, VERDICT.HEALTHY, 'must never report healthy on a symmetric NAT')
})

test('blocked: no public address consensus', (t) => {
  const r = classify(on({ address: { publicHost: null, publicPort: 0 } }))
  t.is(r.verdict, VERDICT.BLOCKED)
  t.is(r.cause, CAUSE.NO_PUBLIC_ADDRESS)
})

test('tier 2 negative: found peers, reached none', (t) => {
  const r = classify(on({
    peerReach: { discovered: 4, connected: 0, exhausted: 4 },
    dials: { attempted: 12, opened: 0 },
  }))
  t.is(r.verdict, VERDICT.BLOCKED)
  t.is(r.cause, CAUSE.PEERS_UNREACHABLE)
  t.is(r.confidence, CONFIDENCE.MEASURED)
})

test('tier 2 negative needs an exhausted peer — a peer still being retried is not evidence', (t) => {
  const r = classify(on({
    peerReach: { discovered: 1, connected: 0, exhausted: 0 },
    dials: { attempted: 1, opened: 0 },
  }))
  t.not(r.verdict, VERDICT.BLOCKED)
})

test('REGRESSION (FIX-5: dial counters are cumulative) — a past success must not disarm the rule', (t) => {
  // stats.connects.client.opened counts for the whole process lifetime, so keying the
  // rule on `opened === 0` silently disabled it after the first ever connection.
  const r = classify(on({
    peerReach: { discovered: 4, connected: 0, exhausted: 4 },
    dials: { attempted: 40, opened: 9 },
  }))
  t.is(r.verdict, VERDICT.BLOCKED)
  t.is(r.cause, CAUSE.PEERS_UNREACHABLE)
})

test('tier 2 positive outranks a bad NAT — a live connection settles it', (t) => {
  const r = classify(on({
    address: { publicHost: '203.0.113.7', publicPort: 0 },
    peerReach: { discovered: 3, connected: 1, exhausted: 0 },
  }))
  t.is(r.verdict, VERDICT.HEALTHY)
  t.is(r.confidence, CONFIDENCE.MEASURED)
})

test('settle window: no verdict before NAT consensus can exist', (t) => {
  const r = classify(on({
    readyAt: 99000,
    now: 99000 + NAT_SETTLE_MS - 1,
    address: { publicHost: '203.0.113.7', publicPort: 0 },
  }))
  t.is(r.verdict, VERDICT.UNKNOWN)
})

test('settle window: a thin routing table is not enough to judge', (t) => {
  const r = classify(on({
    routing: { tableSize: 3 },
    address: { publicHost: '203.0.113.7', publicPort: 0 },
  }))
  t.is(r.verdict, VERDICT.UNKNOWN)
})

test('canary seeder-down does NOT change the verdict', (t) => {
  const healthy = classify(on({ canary: { state: CANARY.SEEDER_DOWN } }))
  t.is(healthy.verdict, VERDICT.HEALTHY, 'our outage must not blame the user')

  const risky = classify(on({
    address: { publicHost: '203.0.113.7', publicPort: 0 },
    canary: { state: CANARY.SEEDER_DOWN },
  }))
  t.is(risky.verdict, VERDICT.AT_RISK)
  t.is(risky.confidence, CONFIDENCE.PREDICTED, 'stays predicted — no corroboration available')
})

test('canary unavailable (source build) behaves exactly like seeder-down', (t) => {
  const a = classify(on({ canary: { state: CANARY.UNAVAILABLE } }))
  const b = classify(on({ canary: { state: CANARY.SEEDER_DOWN } }))
  t.is(a.verdict, b.verdict)
  t.is(a.confidence, b.confidence)
})

test('canary reachable → measured healthy with no spaces joined', (t) => {
  const r = classify(on({ canary: { state: CANARY.REACHABLE } }))
  t.is(r.verdict, VERDICT.HEALTHY)
  t.is(r.confidence, CONFIDENCE.MEASURED)
})

test('canary unreachable CONFIRMS a bad NAT — predicted becomes measured', (t) => {
  const r = classify(on({
    address: { publicHost: '203.0.113.7', publicPort: 0 },
    canary: { state: CANARY.UNREACHABLE },
  }))
  t.is(r.verdict, VERDICT.AT_RISK)
  t.is(r.confidence, CONFIDENCE.MEASURED)
})

test('canary unreachable NEVER creates a verdict on its own', (t) => {
  // NAT looks fine, the seeder was announcing, yet we could not reach it. Unexplainable,
  // so we report unknown rather than accusing the user.
  const r = classify(on({ canary: { state: CANARY.UNREACHABLE } }))
  t.is(r.verdict, VERDICT.UNKNOWN)
  t.not(r.verdict, VERDICT.BLOCKED)
})

test('REGRESSION (FIX-10: an idle app must notice the network vanishing)', (t) => {
  // With no spaces there are no topics, peers or swarm events, dhtReady is one-shot, and
  // the DHT's own health window is gated on traffic that is not happening — so before the
  // liveness probe the verdict stayed frozen at healthy after the Wi-Fi was switched off.
  const healthy = classify(on())
  t.is(healthy.verdict, VERDICT.HEALTHY, 'precondition: healthy while the network is up')

  const oneFailure = classify(on({ liveness: { failures: 1, checkedAt: 1 } }))
  t.is(oneFailure.verdict, VERDICT.HEALTHY, 'a single dropped probe is not enough')

  const gone = classify(on({ liveness: { failures: LIVENESS_FAILURES_FOR_OFFLINE, checkedAt: 1 } }))
  t.is(gone.verdict, VERDICT.BLOCKED)
  t.is(gone.cause, CAUSE.DHT_UNREACHABLE)
  t.is(gone.confidence, CONFIDENCE.MEASURED)
})

test('REGRESSION (FIX-12: link-local addresses are not a network)', (t) => {
  // macOS keeps utun0-3, awdl0 and llw0 up with only fe80:: addresses whether or not Wi-Fi
  // is on. Counting any non-internal address as "connected" meant the offline case never
  // fired on a real Mac — the app kept blaming the user's router instead.
  const linkLocalOnly = {
    lo0:   [{ address: '127.0.0.1', internal: true }],
    utun0: [{ address: 'fe80::b042:7542:92b9:6c19', internal: false }],
    utun3: [{ address: 'fe80::ce81:b1c:bd2c:69e', internal: false }],
    awdl0: [{ address: 'fe80::e482:1eff:fe96:a870', internal: false }],
    llw0:  [{ address: 'fe80::e482:1eff:fe96:a870', internal: false }],
    en0:   [{ address: 'fe80::14ea:3c2a:be88:403', internal: false }],
  }
  t.absent(hasRoutableAddress(linkLocalOnly), 'link-local only is not a network')

  t.absent(hasRoutableAddress({ en1: [{ address: '169.254.5.5', internal: false }] }), 'IPv4 link-local either')
  t.absent(hasRoutableAddress({}), 'no interfaces at all')
  t.absent(hasRoutableAddress(null), 'a missing table is not a network')

  const connected = { ...linkLocalOnly, en0: [
    { address: 'fe80::14ea:3c2a:be88:403', internal: false },
    { address: '192.168.178.140', internal: false },
  ] }
  t.ok(hasRoutableAddress(connected), 'a real routable address counts')
})

test('a VPN holding the only route is classified as tunnel-only', (t) => {
  // Real layout from a Mac with WireGuard up and Wi-Fi off: the tunnel keeps its address
  // and the default route, so the machine still looks "connected" to any local check.
  const wifiOff = {
    lo0:   [{ address: '127.0.0.1', internal: true }],
    utun0: [{ address: 'fe80::b042:7542:92b9:6c19', internal: false }],
    llw0:  [{ address: 'fe80::cc9d:7aff:fea0:c472', internal: false }],
    utun4: [{ address: '192.168.178.201', internal: false }],
  }
  t.is(routableAddressKind(wifiOff), 'tunnel-only')
  t.ok(hasRoutableAddress(wifiOff), 'it genuinely does have a route — we cannot call this offline')

  t.is(routableAddressKind({ ...wifiOff, en0: [{ address: '192.168.178.140', internal: false }] }), 'physical')
  t.is(routableAddressKind({ lo0: [{ address: '127.0.0.1', internal: true }] }), 'none')
})

test('REGRESSION (FIX-13: a dead VPN route is not "your network is blocking us")', (t) => {
  // Indistinguishable from a blocking network by probe alone — so the verdict is the same,
  // but the cause names the likeliest culprit instead of blaming the user's router.
  const blocked = classify(on({
    interfaceKind: 'tunnel-only',
    liveness: { failures: 2, checkedAt: 1 },
  }))
  t.is(blocked.verdict, VERDICT.BLOCKED)
  t.is(blocked.cause, CAUSE.VPN_ONLY_ROUTE)

  const physical = classify(on({
    interfaceKind: 'physical',
    liveness: { failures: 2, checkedAt: 1 },
  }))
  t.is(physical.cause, CAUSE.DHT_UNREACHABLE, 'without a tunnel it stays the generic cause')
})

test('the tunnel hint never creates a verdict on its own', (t) => {
  // Governing rule: a hint refines a cause, it does not invent an outage. A healthy machine
  // that happens to route through a VPN must still read healthy.
  const r = classify(on({ interfaceKind: 'tunnel-only', liveness: { failures: 0, checkedAt: 0 } }))
  t.is(r.verdict, VERDICT.HEALTHY)
  t.is(r.cause, null)
})

test('REGRESSION (FIX-11: switching the network off is instant and says so)', (t) => {
  // No non-internal address on the machine is definitive and local — no probe, no timeout.
  // It must also be reported as os-offline, not as a network that is "blocking" us: the
  // blocked copy tells the user to check a VPN and try another Wi-Fi, which is nonsense
  // when they simply turned the network off.
  const r = classify(on({ hasInterface: false }))
  t.is(r.verdict, VERDICT.BLOCKED)
  t.is(r.cause, CAUSE.OS_OFFLINE)
  t.is(r.confidence, CONFIDENCE.MEASURED)
})

test('a missing interface outranks a healthy-looking NAT and zero liveness failures', (t) => {
  const r = classify(on({
    hasInterface: false,
    liveness: { failures: 0, checkedAt: 0 },
    address: { publicHost: '203.0.113.7', publicPort: 41234 },
  }))
  t.is(r.cause, CAUSE.OS_OFFLINE)
})

test('a live connection outranks failed liveness probes', (t) => {
  const r = classify(on({
    peerReach: { discovered: 2, connected: 1, exhausted: 0 },
    liveness: { failures: 5, checkedAt: 1 },
  }))
  t.is(r.verdict, VERDICT.HEALTHY, 'a connected peer is proof of life')
})

test('losing the network is applied immediately, not held for the dwell', (t) => {
  // The dwell exists to stop inferred verdicts flapping. A repeated direct probe failure
  // is measured, and 20s of "connected" while offline is exactly the lie this fixes.
  const previous = { verdict: VERDICT.HEALTHY, cause: null, since: 0, pending: null }
  const gone = classify(on({ liveness: { failures: LIVENESS_FAILURES_FOR_OFFLINE, checkedAt: 1 } }))
  t.is(stabilise(gone, previous, 1000).verdict, VERDICT.BLOCKED)

  const osOffline = classify(on({ browserOnline: false }))
  t.is(stabilise(osOffline, previous, 1000).verdict, VERDICT.BLOCKED, 'os-offline too')
})

test('recovery from a liveness outage is immediate', (t) => {
  const blocked = { verdict: VERDICT.BLOCKED, cause: CAUSE.DHT_UNREACHABLE, since: 0, pending: null }
  const back = classify(on({ liveness: { failures: 0, checkedAt: 2 } }))
  t.is(stabilise(back, blocked, 5000).verdict, VERDICT.HEALTHY)
})

test('os-offline outranks everything', (t) => {
  const r = classify(on({
    browserOnline: false,
    peerReach: { discovered: 9, connected: 9, exhausted: 0 },
  }))
  t.is(r.verdict, VERDICT.BLOCKED)
  t.is(r.cause, CAUSE.OS_OFFLINE)
})

test('suspended is not a fault', (t) => {
  t.is(classify(on({ suspended: true })).verdict, VERDICT.UNKNOWN)
})

test('dht never ready: unknown inside the grace window, blocked after', (t) => {
  t.is(classify(on({ dhtReady: false, bootedAt: 1, now: 10000 })).verdict, VERDICT.UNKNOWN)
  const late = classify(on({ dhtReady: false, bootedAt: 1, now: 60000 }))
  t.is(late.verdict, VERDICT.BLOCKED)
  t.is(late.cause, CAUSE.DHT_UNREACHABLE)
})

test('degraded transport is reported only when nothing structural was found', (t) => {
  const r = classify(on({ dhtHealth: { online: true, degraded: true, cold: false, idle: false } }))
  t.is(r.cause, CAUSE.UDP_DEGRADED)

  const natWins = classify(on({
    address: { publicHost: '203.0.113.7', publicPort: 0 },
    dhtHealth: { online: true, degraded: true, cold: false, idle: false },
  }))
  t.is(natWins.cause, CAUSE.SYMMETRIC_NAT, 'the actionable finding wins')
})

test('evidence carries the numbers a support case needs', (t) => {
  const r = classify(on({
    peerReach: { discovered: 4, connected: 0, exhausted: 3 },
    dials: { attempted: 9, opened: 0 },
  }))
  t.is(r.evidence.peersDiscovered, 4)
  t.is(r.evidence.peersExhausted, 3)
  t.is(r.evidence.dialsAttempted, 9)
})

test('escalation waits for the dwell window; recovery is immediate', (t) => {
  const healthy = { verdict: VERDICT.HEALTHY, cause: null, since: 0, pending: null }
  const raw = {
    verdict: VERDICT.BLOCKED,
    cause: CAUSE.PEERS_UNREACHABLE,
    confidence: CONFIDENCE.MEASURED,
    evidence: {},
  }

  const first = stabilise(raw, healthy, 1000)
  t.is(first.verdict, VERDICT.HEALTHY, 'held back')
  t.is(first.pending.verdict, VERDICT.BLOCKED)

  const early = stabilise(raw, first, 1000 + BLOCKED_DWELL_MS - 1)
  t.is(early.verdict, VERDICT.HEALTHY, 'still held')

  const late = stabilise(raw, first, 1000 + BLOCKED_DWELL_MS + 1)
  t.is(late.verdict, VERDICT.BLOCKED, 'escalates once sustained')

  const back = stabilise(
    { ...raw, verdict: VERDICT.HEALTHY, cause: null },
    late,
    99999,
  )
  t.is(back.verdict, VERDICT.HEALTHY, 'recovery is not delayed')
})

test('REGRESSION (FIX-6: unknown is not a severity) — leaving unknown is never held back', (t) => {
  const unknown = { verdict: VERDICT.UNKNOWN, cause: null, since: 0, pending: null }
  const healthy = { verdict: VERDICT.HEALTHY, cause: null, confidence: CONFIDENCE.MEASURED, evidence: {} }
  const out = stabilise(healthy, unknown, 1000)
  t.is(out.verdict, VERDICT.HEALTHY, 'unknown -> healthy is immediate, not a 20s escalation')

  const atRisk = { verdict: VERDICT.AT_RISK, cause: CAUSE.SYMMETRIC_NAT, confidence: CONFIDENCE.PREDICTED, evidence: {} }
  t.is(stabilise(atRisk, unknown, 1000).verdict, VERDICT.AT_RISK, 'unknown -> at-risk is immediate too')
})

test('a flapping signal never escalates', (t) => {
  let state = { verdict: VERDICT.HEALTHY, cause: null, since: 0, pending: null }
  const bad = {
    verdict: VERDICT.BLOCKED,
    cause: CAUSE.PEERS_UNREACHABLE,
    confidence: CONFIDENCE.MEASURED,
    evidence: {},
  }
  const good = { verdict: VERDICT.HEALTHY, cause: null, confidence: CONFIDENCE.PREDICTED, evidence: {} }
  for (let i = 0; i < 20; i++) {
    state = stabilise(i % 2 ? bad : good, state, i * 5000)
  }
  t.is(state.verdict, VERDICT.HEALTHY)
})

test('since is preserved while the verdict holds', (t) => {
  const first = stabilise(classify(on()), null, 5000)
  t.is(first.since, 5000)
  const second = stabilise(classify(on()), first, 90000)
  t.is(second.since, 5000, 'unchanged verdict keeps its original timestamp')
})
