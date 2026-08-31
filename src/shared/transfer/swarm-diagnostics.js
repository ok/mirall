// The swarm's read-only reporting surface: the snapshot builders that describe the live Hyperswarm
// without changing it. Its only importer is swarm.js, which assembles them into the status object
// the worker ships over IPC.
//
// A factory over accessors rather than plain functions: `swarm` is reassigned by initSwarm and
// destroySwarm, so a value captured at import time goes stale, and threading the handle through
// fourteen call sites would put it back in every caller's face.
//
// Imports nothing from bare-*, deliberately: that is what lets this load under node and be unit
// tested. The one impure value it reports — the hyperdht version — is read by swarm.js and passed in.
import b4a from 'b4a'
import { CANARY } from '../core/reachability.js'

const DEFAULT_BOOTSTRAP = ['node1.hyperdht.org:49737', 'node2.hyperdht.org:49737', 'node3.hyperdht.org:49737']


export function createSwarmDiagnostics({ getSwarm, getRelaySelections, getDhtVersion }) {
  function getBootstrapList() {
    try {
      const list = global.Pear?.config?.dht?.bootstrap
      if (Array.isArray(list)) return list.map(String)
    } catch {}
      // A copy: this array is handed to every status reader, and the fallback must not be mutable
    // through one of them.
    return DEFAULT_BOOTSTRAP.slice()
  }

  function safeAddress() {
    try {
      const addr = getSwarm()?.dht?.address?.()
      if (addr && typeof addr.port === 'number') {
        return { host: typeof addr.host === 'string' ? addr.host : null, port: addr.port }
      }
    } catch {}
    return { host: null, port: 0 }
  }

  function safeRoutingTableSize() {
    try {
      const arr = getSwarm()?.dht?.toArray?.({ limit: 50 })
      return Array.isArray(arr) ? arr.length : 0
    } catch { return 0 }
  }

  // The gap between peers we DISCOVERED on our topics and peers we actually connected to
  // is the strongest connectivity signal available: the DHT told us where they are and we
  // could not open a socket to any of them.
  function snapshotPeerReach() {
    const peers = getSwarm()?.peers
    if (!peers) return { discovered: 0, connected: 0, exhausted: 0 }
    let exhausted = 0
    for (const info of peers.values()) {
      // attempts > 3 is where hyperswarm's _shouldRequeue gives up and the peer leaves the
      // retry queue until a fresh lookup rediscovers it.
      if (!info.proven && info.attempts > 3) exhausted++
    }
    return { discovered: peers.size, connected: getSwarm().connections?.size || 0, exhausted }
  }

  const PEER_SAMPLE_CAP = 32

  // PeerInfo.topics carries an upstream "remove on next major" marker, so never assume it.
  function topicHexOf(info) {
    const topic = Array.isArray(info?.topics) ? info.topics[0] : null
    if (!topic) return null
    try { return b4a.toString(topic, 'hex') } catch { return null }
  }

  function snapshotPeerSamples() {
    const peers = getSwarm()?.peers
    if (!peers) return []
    const out = []
    for (const [key, info] of peers) {
      if (out.length >= PEER_SAMPLE_CAP) break
      out.push({
        publicKey: key,
        topic: topicHexOf(info),
        attempts: info.attempts || 0,
        proven: !!info.proven,
      })
    }
    return out
  }

  function snapshotDhtHealth() {
    const health = getSwarm()?.dht?.health
    if (!health) return { online: true, degraded: false, cold: true, idle: true, timeoutsRate: 0 }
    const s = health.stats || {}
    return {
      online: s.online !== false,
      degraded: !!s.degraded,
      cold: !!s.cold,
      idle: !!s.idle,
      timeoutsRate: typeof s.timeoutsRate === 'number' ? s.timeoutsRate : 0,
    }
  }

  function snapshotStats() {
    const s = getSwarm()?.stats || {}
    const c = s.connects || {}
    const cl = c.client || {}
    const sv = c.server || {}
    return {
      updates: s.updates || 0,
      connects: {
        client: { opened: cl.opened || 0, closed: cl.closed || 0, attempted: cl.attempted || 0 },
        server: { opened: sv.opened || 0, closed: sv.closed || 0, attempted: sv.attempted || 0 },
      },
      bannedPeers: s.bannedPeers || 0,
      relaying: snapshotRelayingStats(),
    }
  }

  // hyperdht counts relayed connection attempts on the DHT node, not the swarm, so this
  // reads through to the shared node rather than swarm.stats.
  function snapshotRelayingStats() {
    const r = getSwarm()?.dht?.stats?.relaying || {}
    return { selected: getRelaySelections(), attempts: r.attempts || 0, successes: r.successes || 0, aborts: r.aborts || 0 }
  }

  function offlineStatusSnapshot() {
    return {
      state: 'offline',
      dhtReady: false,
      announced: false,
      peerCount: 0,
      connecting: 0,
      suspended: false,
      lastConnectionAt: null,
      bootedAt: 0,
      identity: { publicKey: '', nodeId: null },
      address: { publicHost: null, publicPort: 0, localPort: 0 },
      nat: { firewalled: null, randomized: null, ephemeral: true },
      routing: { bootstrap: getBootstrapList(), tableSize: 0 },
      topics: 0,
      stats: {
        updates: 0,
        connects: {
          client: { opened: 0, closed: 0, attempted: 0 },
          server: { opened: 0, closed: 0, attempted: 0 },
        },
        bannedPeers: 0,
        relaying: { selected: 0, attempts: 0, successes: 0, aborts: 0 },
      },
      peerReach: { discovered: 0, connected: 0, exhausted: 0 },
      dhtHealth: { online: false, degraded: false, cold: true, idle: true, timeoutsRate: 0 },
      canary: { state: CANARY.UNAVAILABLE, at: 0 },
      liveness: { failures: 0, checkedAt: 0, interfaceKind: 'physical' },
      reachability: { verdict: 'unknown', cause: null, confidence: 'predicted', evidence: null, since: 0, pending: null },
      versions: { dht: getDhtVersion() },
    }
  }

  return {
    getBootstrapList,
    safeAddress,
    safeRoutingTableSize,
    snapshotPeerReach,
    snapshotPeerSamples,
    snapshotDhtHealth,
    snapshotStats,
    offlineStatusSnapshot,
  }
}
