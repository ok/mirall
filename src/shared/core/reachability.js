// Reachability verdict: the one place the app decides whether the user can actually
// reach peers. Deliberately dependency-free so it loads under node — swarm.js pulls
// bare-* modules and cannot.
//
// GOVERNING RULE: the canary may CONFIRM a verdict, never CREATE one. A canary failure
// is indistinguishable from our own seeder being down, so it can raise confidence and
// promote to healthy, but is never the sole basis for telling a user their network is
// broken.

export const VERDICT = {
  HEALTHY: 'healthy',
  AT_RISK: 'at-risk',
  BLOCKED: 'blocked',
  UNKNOWN: 'unknown',
}

export const CAUSE = {
  OS_OFFLINE: 'os-offline',
  DHT_UNREACHABLE: 'dht-unreachable',
  NO_PUBLIC_ADDRESS: 'no-public-address',
  SYMMETRIC_NAT: 'symmetric-nat',
  UDP_DEGRADED: 'udp-degraded',
  PEERS_UNREACHABLE: 'peers-unreachable',
  VPN_ONLY_ROUTE: 'vpn-only-route',
}

export const CONFIDENCE = { MEASURED: 'measured', PREDICTED: 'predicted' }

export const CANARY = {
  UNAVAILABLE: 'unavailable',
  PENDING: 'pending',
  SEEDER_DOWN: 'seeder-down',
  REACHABLE: 'reachable',
  UNREACHABLE: 'unreachable',
}

// Measured from dhtReady, NOT from boot. dht-rpc emits 'ready' only after the bootstrap
// FIND_NODE walk completes, and that walk is what fed the NAT sampler — so the NAT
// verdict is ready when dhtReady is. This short window only covers a consensus still
// forming and gives the canary room to confirm.
export const NAT_SETTLE_MS = 5000
export const DHT_FAILURE_MS = 45000
export const MIN_ROUTING_TABLE = 8
export const MIN_EXHAUSTED_PEERS = 1
export const BLOCKED_DWELL_MS = 20000
// Consecutive liveness-probe failures before the network counts as gone.
export const LIVENESS_FAILURES_FOR_OFFLINE = 2

// Losing the network is a hard, directly-measured event, not an inference from NAT shape.
// Holding it back for the anti-flap dwell would keep showing "connected" while the user
// stares at a laptop with the Wi-Fi off.
const IMMEDIATE_CAUSES = new Set([CAUSE.OS_OFFLINE, CAUSE.DHT_UNREACHABLE])

// Virtual point-to-point interfaces. A VPN keeps one of these UP with an address and the
// default route even when its underlying transport is dead, so "there is a route" stops
// meaning "there is connectivity".
const TUNNEL_PREFIXES = ['utun', 'tun', 'tap', 'wg', 'ppp', 'ipsec', 'gpd', 'nordlynx']

function isTunnelName(name) {
  const lower = String(name || '').toLowerCase()
  return TUNNEL_PREFIXES.some((prefix) => lower.startsWith(prefix))
}

// A link-local address (169.254.x / fe80::) means the interface has no configured route —
// macOS keeps utun*, awdl0 and llw0 up with only those whether or not Wi-Fi is on, so
// counting any non-internal address as "connected" never reports being offline.
function isRoutable(addr) {
  if (!addr || addr.internal) return false
  const ip = String(addr.address || '')
  if (!ip) return false
  if (ip.startsWith('169.254.')) return false
  if (ip.toLowerCase().startsWith('fe80')) return false
  return true
}

// 'none'        — nothing routable anywhere; the machine is definitively offline.
// 'tunnel-only' — every routable address is on a VPN/tunnel. Not proof of anything on its
//                 own, but if we also cannot reach the network it is by far the most
//                 likely culprit, and the most useful thing to tell the user first.
// 'physical'    — at least one ordinary interface has a routable address.
export function routableAddressKind(interfaces) {
  let sawTunnel = false
  for (const [name, addresses] of Object.entries(interfaces || {})) {
    for (const addr of addresses || []) {
      if (!isRoutable(addr)) continue
      if (!isTunnelName(name)) return 'physical'
      sawTunnel = true
    }
  }
  return sawTunnel ? 'tunnel-only' : 'none'
}

export function hasRoutableAddress(interfaces) {
  return routableAddressKind(interfaces) !== 'none'
}

function verdictRank(verdict) {
  if (verdict === VERDICT.BLOCKED) return 3
  if (verdict === VERDICT.AT_RISK) return 2
  return 1
}

function isEscalation(next, previous) {
  if (next === VERDICT.UNKNOWN || previous === VERDICT.UNKNOWN) return false
  return verdictRank(next) > verdictRank(previous)
}

// The short-circuits: each is decisive on its own and outranks everything below it.
// Returns null when nothing conclusive applies and the NAT shape should decide.
function decisiveVerdict(input) {
  const { now, bootedAt, readyAt, dhtReady, suspended, browserOnline, routing, peerReach, liveness } = input

  // No non-internal address on the machine is definitive and instant — no probe needed,
  // and it means "you are offline", not "your network is blocking us".
  if (input.hasInterface === false) return [VERDICT.BLOCKED, CAUSE.OS_OFFLINE, CONFIDENCE.MEASURED]
  if (!browserOnline) return [VERDICT.BLOCKED, CAUSE.OS_OFFLINE, CONFIDENCE.MEASURED]
  if (suspended) return [VERDICT.UNKNOWN, null, CONFIDENCE.PREDICTED]

  if (!dhtReady) {
    const sinceBoot = bootedAt > 0 ? now - bootedAt : 0
    return sinceBoot < DHT_FAILURE_MS
      ? [VERDICT.UNKNOWN, null, CONFIDENCE.PREDICTED]
      : [VERDICT.BLOCKED, CAUSE.DHT_UNREACHABLE, CONFIDENCE.MEASURED]
  }

  // A live connection settles it, whatever the NAT shape says.
  if (peerReach.connected > 0) return [VERDICT.HEALTHY, null, CONFIDENCE.MEASURED]

  // Nothing else can notice an idle app losing the network: dhtReady is one-shot, the DHT's
  // own health window is gated on traffic that is not happening, and with no topics joined
  // there are no swarm events at all.
  if ((liveness?.failures ?? 0) >= LIVENESS_FAILURES_FOR_OFFLINE) {
    // A VPN that keeps the only route while its transport is dead looks identical to a
    // network that blocks us. We cannot tell them apart — but we can say which is likelier.
    const cause = input.interfaceKind === 'tunnel-only' ? CAUSE.VPN_ONLY_ROUTE : CAUSE.DHT_UNREACHABLE
    return [VERDICT.BLOCKED, cause, CONFIDENCE.MEASURED]
  }

  // Found them, reached none — an outcome rather than a prediction. Keyed on `exhausted`
  // rather than the dial counters, which are cumulative for the process lifetime.
  if (peerReach.discovered > 0 && peerReach.exhausted >= MIN_EXHAUSTED_PEERS) {
    return [VERDICT.BLOCKED, CAUSE.PEERS_UNREACHABLE, CONFIDENCE.MEASURED]
  }

  const sinceReady = readyAt > 0 ? now - readyAt : 0
  if (sinceReady < NAT_SETTLE_MS || routing.tableSize < MIN_ROUTING_TABLE) {
    return [VERDICT.UNKNOWN, null, CONFIDENCE.PREDICTED]
  }

  if (input.canary.state === CANARY.REACHABLE) return [VERDICT.HEALTHY, null, CONFIDENCE.MEASURED]

  return null
}

function natVerdict(address, dhtHealth) {
  if (address.publicHost === null) return [VERDICT.BLOCKED, CAUSE.NO_PUBLIC_ADDRESS]
  // Symmetric NAT. NOT certain failure — this user can still reach peers with a stable
  // mapping, throttled by hyperdht's _randomPunchLimit of 1 per 20s.
  if (address.publicPort === 0) return [VERDICT.AT_RISK, CAUSE.SYMMETRIC_NAT]
  if (dhtHealth.degraded) return [VERDICT.AT_RISK, CAUSE.UDP_DEGRADED]
  return [VERDICT.HEALTHY, null]
}

export function classify(input) {
  const { address, dhtHealth, peerReach, dials, canary, liveness } = input

  const evidence = {
    peersDiscovered: peerReach.discovered,
    peersConnected: peerReach.connected,
    peersExhausted: peerReach.exhausted,
    dialsAttempted: dials.attempted,
    dialsOpened: dials.opened,
    publicPort: address.publicPort,
    canary: canary.state,
    livenessFailures: liveness?.failures ?? 0,
  }
  const out = (verdict, cause, confidence) => ({ verdict, cause, confidence, evidence })

  const decisive = decisiveVerdict(input)
  if (decisive) return out(decisive[0], decisive[1], decisive[2])

  const [verdict, cause] = natVerdict(address, dhtHealth)

  if (canary.state === CANARY.UNREACHABLE) {
    // Stage 1 found the seeder, stage 2 could not reach it, and the NAT looks fine.
    // Unexplainable, so we do not accuse.
    if (verdict === VERDICT.HEALTHY) return out(VERDICT.UNKNOWN, null, CONFIDENCE.PREDICTED)
    return out(verdict, cause, CONFIDENCE.MEASURED)
  }

  // UNAVAILABLE / SEEDER_DOWN / PENDING fall through untouched: our outage must never
  // change the user's verdict.
  return out(verdict, cause, CONFIDENCE.PREDICTED)
}

// Escalating to a worse verdict requires BLOCKED_DWELL_MS of agreement; recovery is
// immediate.
export function stabilise(raw, previous, now) {
  if (!previous || previous.verdict === raw.verdict) {
    return { ...raw, since: previous?.since || now, pending: null }
  }

  if (!isEscalation(raw.verdict, previous.verdict) || IMMEDIATE_CAUSES.has(raw.cause)) {
    return { ...raw, since: now, pending: null }
  }

  const pendingSince = previous.pending?.verdict === raw.verdict ? previous.pending.since : now
  if (now - pendingSince < BLOCKED_DWELL_MS) {
    return { ...previous, pending: { verdict: raw.verdict, since: pendingSince } }
  }
  return { ...raw, since: now, pending: null }
}
