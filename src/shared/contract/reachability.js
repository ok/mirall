// The vocabulary of the reachability verdict: what the app concluded, why, how sure it is, and what
// the canary probe saw. The verdict LOGIC lives in core/reachability.js; this is only the names, so
// the renderer can derive its unions from them rather than re-listing them.
export const VERDICT = Object.freeze({
  HEALTHY: 'healthy',
  AT_RISK: 'at-risk',
  BLOCKED: 'blocked',
  UNKNOWN: 'unknown',
})

export const CAUSE = Object.freeze({
  OS_OFFLINE: 'os-offline',
  DHT_UNREACHABLE: 'dht-unreachable',
  NO_PUBLIC_ADDRESS: 'no-public-address',
  SYMMETRIC_NAT: 'symmetric-nat',
  UDP_DEGRADED: 'udp-degraded',
  PEERS_UNREACHABLE: 'peers-unreachable',
  VPN_ONLY_ROUTE: 'vpn-only-route',
})

// Whether the verdict was measured or inferred. The canary may CONFIRM a verdict, never create one,
// so a promotion to healthy raises this while a failure alone never lowers it.
export const CONFIDENCE = Object.freeze({ MEASURED: 'measured', PREDICTED: 'predicted' })

export const CANARY = Object.freeze({
  UNAVAILABLE: 'unavailable',
  PENDING: 'pending',
  SEEDER_DOWN: 'seeder-down',
  REACHABLE: 'reachable',
  UNREACHABLE: 'unreachable',
})

export const VERDICTS = Object.freeze(Object.values(VERDICT))
export const CAUSES = Object.freeze(Object.values(CAUSE))
export const CONFIDENCES = Object.freeze(Object.values(CONFIDENCE))
export const CANARY_STATES = Object.freeze(Object.values(CANARY))
