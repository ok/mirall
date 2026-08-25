import test from 'brittle'
import { buildDiagnostics, DIAGNOSTICS_SCHEMA } from '../../src/shared/transfer/diagnostics.js'

const PUBLIC_HOST = '203.0.113.7'
const PUBLIC_KEY = 'a'.repeat(64)
const NODE_ID = 'b'.repeat(64)
const PEER_KEY = 'c'.repeat(64)
const TOPIC = 'd'.repeat(64)
const BOOTSTRAP = ['node1.example.test:49737', 'node2.example.test:49737']
const INSTALL_ID = '4f2a91c7-0000-4000-8000-000000000000'

function makeCtx(over = {}) {
  return {
    status: {
      dhtReady: true,
      announced: true,
      address: { publicHost: PUBLIC_HOST, publicPort: 0, localPort: 63418 },
      identity: { publicKey: PUBLIC_KEY, nodeId: NODE_ID },
      nat: { firewalled: true, randomized: true, ephemeral: true },
      routing: { tableSize: 50, bootstrap: BOOTSTRAP },
      topics: 1,
      reachability: { verdict: 'at-risk', cause: 'symmetric-nat', confidence: 'measured', since: 10 },
      peerReach: { discovered: 4, connected: 0, exhausted: 4 },
      dhtHealth: { online: true, degraded: false, cold: false, idle: false, timeoutsRate: 0.04 },
      canary: { state: 'unreachable', at: 20 },
      liveness: { failures: 0, checkedAt: 18, interfaceKind: 'tunnel-only' },
      stats: {
        connects: {
          client: { opened: 0, closed: 17, attempted: 17 },
          server: { opened: 0, closed: 0, attempted: 0 },
        },
        bannedPeers: 0,
        relaying: { selected: 0, attempts: 0, successes: 0, aborts: 0 },
      },
      ...over.status,
    },
    history: [{ at: 1, verdict: 'unknown', cause: null, confidence: 'predicted' }],
    env: {
      appVersion: '1.8.0',
      channel: 'prod',
      installId: INSTALL_ID,
      packaged: true,
      platform: 'darwin',
      release: '24.6.0',
      arch: 'arm64',
    },
    counters: { readyAt: 4400, bootedAt: 1000, hostChangeCount: 0, localPortStable: true },
    peerSamples: [
      { publicKey: PEER_KEY, topic: TOPIC, attempts: 5, proven: false },
      { publicKey: 'e'.repeat(64), topic: TOPIC, attempts: 4, proven: false },
    ],
    ...over,
  }
}

test('REGRESSION (FIX-3: bundle must not leak identity) — redacted bundle carries no IP, key, node id or bootstrap host', (t) => {
  const serialised = JSON.stringify(buildDiagnostics(makeCtx(), true))
  t.absent(serialised.includes(PUBLIC_HOST), 'public IP absent')
  t.absent(serialised.includes(PUBLIC_KEY), 'public key absent')
  t.absent(serialised.includes(NODE_ID), 'node id absent')
  t.absent(serialised.includes(PEER_KEY), 'peer key absent')
  for (const host of BOOTSTRAP) t.absent(serialised.includes(host), 'bootstrap host absent')
  t.absent(serialised.includes(TOPIC), 'topic absent')
  t.absent(serialised.includes(INSTALL_ID), 'full install id absent')
})

test('the symmetric-NAT finding survives redaction', (t) => {
  // publicPort === 0 identifies nobody and IS the diagnosis — redacting it would make the
  // bundle useless for the case it exists to serve.
  const bundle = buildDiagnostics(makeCtx(), true)
  t.is(bundle.network.publicPort, 0)
  t.is(bundle.network.publicHostKnown, true)
  t.is(bundle.network.randomized, true)
  t.is(bundle.network.routingTableSize, 50)
})

test('peer counts and dial outcomes survive redaction', (t) => {
  const bundle = buildDiagnostics(makeCtx(), true)
  t.is(bundle.peers.discovered, 4)
  t.is(bundle.peers.connected, 0)
  t.is(bundle.peers.exhausted, 4)
  t.is(bundle.peers.dials.attempted, 17)
  t.is(bundle.peers.dials.opened, 0)
  t.is(bundle.peers.samples[0].attempts, 5)
  t.is(bundle.peers.samples[0].proven, false)
})

test('unredacted bundle carries the real values', (t) => {
  const bundle = buildDiagnostics(makeCtx(), false)
  t.is(bundle.network.publicHost, PUBLIC_HOST)
  t.is(bundle.network.publicKey, PUBLIC_KEY)
  t.is(bundle.network.nodeId, NODE_ID)
  t.alike(bundle.network.bootstrap, BOOTSTRAP)
  t.is(bundle.peers.samples[0].peer, PEER_KEY)
  t.is(bundle.redacted, false)
})

test('topic aliases are consistent between the peers and spaces sections', (t) => {
  const bundle = buildDiagnostics(makeCtx(), true)
  const fromPeers = new Set(bundle.peers.samples.map((sample) => sample.topic))
  t.ok(bundle.spaces.topics.length > 0)
  for (const topic of bundle.spaces.topics) t.ok(fromPeers.has(topic), 'same alias space')
})

test('reference is the install-id prefix, not the whole id', (t) => {
  const bundle = buildDiagnostics(makeCtx(), true)
  t.is(bundle.reference.length, 8)
  t.is(bundle.reference, INSTALL_ID.slice(0, 8))
})

test('a source build with no install id still produces a valid bundle', (t) => {
  const ctx = makeCtx()
  ctx.env.installId = null
  ctx.env.packaged = false
  const bundle = buildDiagnostics(ctx, true)
  t.is(bundle.reference, null)
  t.is(bundle.app.build, 'source')
  t.is(bundle.schema, DIAGNOSTICS_SCHEMA)
})

test('readyAfterMs is derived, and null when the DHT never came up', (t) => {
  t.is(buildDiagnostics(makeCtx(), true).network.readyAfterMs, 3400)
  const ctx = makeCtx()
  ctx.counters.readyAt = 0
  t.is(buildDiagnostics(ctx, true).network.readyAfterMs, null)
})

test('an empty swarm produces a well-formed bundle', (t) => {
  const ctx = makeCtx()
  ctx.peerSamples = []
  ctx.status.peerReach = { discovered: 0, connected: 0, exhausted: 0 }
  const bundle = buildDiagnostics(ctx, true)
  t.alike(bundle.peers.samples, [])
  t.alike(bundle.spaces.topics, [])
})
