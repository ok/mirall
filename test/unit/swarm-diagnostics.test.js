import test from 'brittle'
import { createSwarmDiagnostics } from '../../src/shared/transfer/swarm-diagnostics.js'

// The module imports nothing from bare-*, which is what lets it be tested here rather than in the
// slow integration tier. A future edit that pulls in a bare module breaks this file loudly.
const make = (swarm, { relaySelections = 0, dhtVersion = '1.2.3' } = {}) =>
  createSwarmDiagnostics({ getSwarm: () => swarm, getRelaySelections: () => relaySelections, getDhtVersion: () => dhtVersion })

test('every snapshot degrades to a zero shape with no swarm', (t) => {
  const d = make(null)
  t.alike(d.safeAddress(), { host: null, port: 0 })
  t.is(d.safeRoutingTableSize(), 0)
  t.alike(d.snapshotPeerReach(), { discovered: 0, connected: 0, exhausted: 0 })
  t.alike(d.snapshotPeerSamples(), [])
  t.is(d.snapshotStats().updates, 0)
})

// A torn-down DHT is the condition these two exist to absorb: getSwarmStatus deliberately runs them
// against a swarm it has already established may be destroyed.
test('safeAddress and safeRoutingTableSize absorb a throwing DHT', (t) => {
  const boom = { get dht() { throw new Error('destroyed') } }
  t.alike(make(boom).safeAddress(), { host: null, port: 0 }, 'no throw escapes')
  t.is(make(boom).safeRoutingTableSize(), 0)
})

test('peer reach counts the discovered/connected gap and the exhausted retries', (t) => {
  // attempts > 3 is where hyperswarm stops requeueing, so that is what "exhausted" means.
  const peers = new Map([
    ['a', { proven: true, attempts: 1 }],
    ['b', { proven: false, attempts: 9 }],
    ['c', { proven: false, attempts: 2 }],
  ])
  const d = make({ peers, connections: { size: 1 } })
  t.alike(d.snapshotPeerReach(), { discovered: 3, connected: 1, exhausted: 1 })
})

test('peer samples are capped and tolerate the removable topics field', (t) => {
  // PeerInfo.topics carries an upstream "remove on next major" marker, so a missing one must not throw.
  const peers = new Map(Array.from({ length: 40 }, (_, i) => [String(i), { attempts: i, proven: false }]))
  const out = make({ peers }).snapshotPeerSamples()
  t.is(out.length, 32, 'capped')
  t.is(out[0].topic, null, 'a peer with no topics reports null, not a crash')
})

test('relay selections come from the accessor, not the swarm', (t) => {
  const d = make({ dht: { stats: { relaying: { attempts: 4, successes: 2, aborts: 1 } } } }, { relaySelections: 7 })
  t.alike(d.snapshotStats().relaying, { selected: 7, attempts: 4, successes: 2, aborts: 1 })
})

// REGRESSION (FIX-BOOTSTRAP-REF): getBootstrapList used to hand out the module's own fallback array.
// Every status read shares one array, so a caller sorting or pushing to status.routing.bootstrap
// corrupted the fallback for the rest of the process.
test('REGRESSION (FIX-BOOTSTRAP-REF): the bootstrap fallback is copied, not shared', (t) => {
  const d = make(null)
  const first = d.getBootstrapList()
  first.push('evil.example:1')
  t.absent(d.getBootstrapList().includes('evil.example:1'), 'a mutating caller cannot poison the default')
  t.not(d.getBootstrapList(), first, 'a fresh array each read')
})

test('the offline snapshot reports the injected dht version', (t) => {
  t.is(make(null, { dhtVersion: '9.9.9' }).offlineStatusSnapshot().versions.dht, '9.9.9')
})
