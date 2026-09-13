// Generated from reachability.js — contract-declarations.test.js asserts the two agree.
export declare const VERDICT: Readonly<{ HEALTHY: 'healthy'; AT_RISK: 'at-risk'; BLOCKED: 'blocked'; UNKNOWN: 'unknown' }>
export declare const CAUSE: Readonly<{ OS_OFFLINE: 'os-offline'; DHT_UNREACHABLE: 'dht-unreachable'; NO_PUBLIC_ADDRESS: 'no-public-address'; SYMMETRIC_NAT: 'symmetric-nat'; UDP_DEGRADED: 'udp-degraded'; PEERS_UNREACHABLE: 'peers-unreachable'; VPN_ONLY_ROUTE: 'vpn-only-route' }>
export declare const CONFIDENCE: Readonly<{ MEASURED: 'measured'; PREDICTED: 'predicted' }>
export declare const CANARY: Readonly<{ UNAVAILABLE: 'unavailable'; PENDING: 'pending'; SEEDER_DOWN: 'seeder-down'; REACHABLE: 'reachable'; UNREACHABLE: 'unreachable' }>
export declare const VERDICTS: readonly ['healthy', 'at-risk', 'blocked', 'unknown']
export declare const CAUSES: readonly ['os-offline', 'dht-unreachable', 'no-public-address', 'symmetric-nat', 'udp-degraded', 'peers-unreachable', 'vpn-only-route']
export declare const CONFIDENCES: readonly ['measured', 'predicted']
export declare const CANARY_STATES: readonly ['unavailable', 'pending', 'seeder-down', 'reachable', 'unreachable']
