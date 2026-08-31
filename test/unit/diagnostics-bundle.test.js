import test from 'brittle'
import { buildDiagnostics, verdictHistoryFromAudit, VERDICT_KINDS, DIAGNOSTICS_SCHEMA } from '../../src/shared/transfer/diagnostics.js'

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

// The in-memory ring dies with the process, so a bundle collected after a restart — the one a user
// actually sends — carried no history at all.
test('the verdict history survives a restart by coming from the log', (t) => {
  const history = verdictHistoryFromAudit([
    { kind: 'network.restored', ts: 3000, code: 'os-offline', subject: { durationMs: 600000, sinceTs: 3000, peersConnected: 2 } },
    { kind: 'network.blocked', ts: 2000, code: 'peers-unreachable', subject: { sinceTs: 1900, confidence: 'measured' } },
  ])
  t.alike(history.map((h) => h.verdict), ['blocked', 'healthy'], 'oldest first, matching the ring')
  t.is(history[0].cause, 'peers-unreachable')
  t.is(history[0].confidence, 'measured')
  t.is(history[1].durationMs, 600000)
})

test('PRIVACY: peer-family rows never reach the bundle', (t) => {
  const history = verdictHistoryFromAudit([{
    kind: 'network.peer_lost',
    ts: 1000,
    code: null,
    actor: { type: 'peer', key: 'deadbeef', name: 'Anna Keller' },
    space: { id: 'sp1', name: 'Design Team' },
    subject: { sinceTs: 900 },
  }])
  t.is(history.length, 0, 'they carry names; the device family does not')
  t.absent(JSON.stringify(history).includes('Anna'))
  t.absent(JSON.stringify(history).includes('Design Team'))
})

test('a row from an unknown kind is dropped rather than mapped to a bogus verdict', (t) => {
  t.is(verdictHistoryFromAudit([{ kind: 'member.joined', ts: 1, subject: {} }]).length, 0)
  t.is(verdictHistoryFromAudit().length, 0)
})

// Querying the whole `network` category would let peer-presence rows fill the page limit and crowd
// the device history out of the bundle, so the query filters on exactly what the mapper reads.
test('the query filter and the mapper cannot drift apart', (t) => {
  t.alike(VERDICT_KINDS.slice().sort(), ['network.at_risk', 'network.blocked', 'network.offline', 'network.restored'])
  for (const kind of VERDICT_KINDS) {
    t.is(verdictHistoryFromAudit([{ kind, ts: 1, code: null, subject: {} }]).length, 1, kind + ' maps')
  }
  t.is(verdictHistoryFromAudit([{ kind: 'network.peer_lost', ts: 1, subject: {} }]).length, 0, 'and the peer family does not')
})

// buildDiagnostics names every key it carries and silently drops the rest. That is not a
// hypothetical: requestFailures (#118) and requestMetrics (#120) each shipped as a no-op because
// the producer was wired and the builder never named the key. These are the guards that were
// missing both times.
test('REGRESSION (FIX-R09-7): the health block survives the builder', (t) => {
  const bundle = buildDiagnostics(makeCtx({ health: { loopLagMs: 42, loopLagMaxMs: 900, queueDepth: 3 } }), true)
  t.alike(bundle.health, { loopLagMs: 42, loopLagMaxMs: 900, queueDepth: 3 })
})

test('REGRESSION (FIX-OBS-1/R09-7): the requests block survives the builder', (t) => {
  const bundle = buildDiagnostics(makeCtx({
    requestMetrics: { 'space:members': { calls: 11, failures: 1, inFlight: 0, avgMs: 7, maxMs: 30, slow: 0 } },
    requestFailures: { 'space:members:NOT_FOUND': 1 },
  }), true)
  t.is(bundle.requests.metrics['space:members'].calls, 11)
  t.is(bundle.requests.failures['space:members:NOT_FOUND'], 1)
})

test('an absent health block defaults rather than throwing', (t) => {
  // The worker always supplies it, but a caller that predates the field must not crash the export.
  t.alike(buildDiagnostics(makeCtx(), true).health, {})
})

test('the health block carries no identifying values, so redaction is a no-op for it', (t) => {
  const health = { loopLagMs: 5, loopLagMaxMs: 5, queueDepth: 0 }
  t.alike(buildDiagnostics(makeCtx({ health }), true).health, buildDiagnostics(makeCtx({ health }), false).health)
})
