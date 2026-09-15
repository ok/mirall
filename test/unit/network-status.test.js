import test from 'brittle'
import {
  initNetworkStatus, resetNetworkStatus, getSwarmStatus, getVerdictHistory, scheduleStatusEmit,
  statusEqual, STATUS_PATHS,
} from '../../src/shared/network/network-status.js'
import { createSwarmDiagnostics } from '../../src/shared/network/swarm-diagnostics.js'

const silentLog = { debug() {}, info() {}, warn() {}, error() {} }
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

// statusEqual dedups network-status events: a fresh status equal to the last is not re-emitted.
// The refactor risk is a dropped or duplicated leaf, so this builds a representative frame and
// asserts that changing any listed leaf breaks equality, and that every listed leaf exists.
function makeStatus() {
  return {
    state: 'connected', dhtReady: true, announced: true, peerCount: 3, connecting: false,
    suspended: false, lastConnectionAt: 1000, bootedAt: 500,
    identity: { publicKey: 'pk', nodeId: 'nid' },
    address: { publicHost: 'host', publicPort: 1, localPort: 2 },
    nat: { firewalled: false, randomized: false, ephemeral: false },
    routing: { tableSize: 7 }, topics: 2,
    stats: {
      updates: 4,
      connects: { client: { opened: 5, closed: 1 }, server: { opened: 6, closed: 2 } },
      bannedPeers: 0,
      relaying: { selected: 0, attempts: 0, successes: 0, aborts: 0 },
    },
    peerReach: { discovered: 4, connected: 1, exhausted: 2 },
    dhtHealth: { online: true, degraded: false, cold: false, idle: false, timeoutsRate: 0.1 },
    canary: { state: 'reachable', at: 900 },
    liveness: { failures: 0, checkedAt: 880, interfaceKind: 'physical' },
    reachability: { verdict: 'healthy', cause: null, confidence: 'measured', since: 800 },
  }
}

const clone = (o) => JSON.parse(JSON.stringify(o))
function setPath(obj, path, val) {
  const keys = path.split('.')
  let o = obj
  for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]]
  o[keys.at(-1)] = val
}
const getPath = (obj, path) => path.split('.').reduce((o, k) => o[k], obj)

test('statusEqual: reference / deep-equal / nullish', (t) => {
  const base = makeStatus()
  t.ok(statusEqual(base, base), 'same reference is equal')
  t.ok(statusEqual(base, clone(base)), 'a deep-equal clone is equal')
  t.absent(statusEqual(base, null), 'b nullish → not equal')
  t.absent(statusEqual(null, base), 'a nullish → not equal')
  t.ok(statusEqual(null, null), 'both null are reference-equal (a === b guard) → equal')
})

test('statusEqual: every compared path is a real leaf, and any single difference breaks equality', (t) => {
  const base = makeStatus()
  t.is(new Set(STATUS_PATHS).size, STATUS_PATHS.length, 'no path is listed twice')
  for (const path of STATUS_PATHS) {
    t.not(getPath(base, path), undefined, `${path} is a leaf of the frame`)
    const mutated = clone(base)
    setPath(mutated, path, `changed-${path}`)
    t.absent(statusEqual(base, mutated), `differs on ${path}`)
  }
})

function fakeSwarm() {
  return {
    dht: { host: '5.6.7.8', port: 4000, firewalled: false, randomized: false, ephemeral: false, id: null },
    connections: new Set(),
    connecting: 0,
    suspended: false,
    destroyed: false,
    keyPair: null,
  }
}

function status(t, { swarm = fakeSwarm(), ipc = null } = {}) {
  const ledger = { dhtReady: true, readyAt: 1, bootedAt: 1, announced: false, lastConnectionAt: null, browserOnline: true }
  const diag = createSwarmDiagnostics({ getSwarm: () => swarm, getRelaySelections: () => 0, getDhtVersion: () => '0' })
  initNetworkStatus({ log: silentLog, diag, getSwarm: () => swarm, getIpc: () => ipc, dhtVersion: '0', readiness: () => ledger })
  t.teardown(() => resetNetworkStatus())
  return ledger
}

test('the frame carries every compared leaf and a folded verdict', (t) => {
  status(t)
  const frame = getSwarmStatus()
  for (const path of STATUS_PATHS) t.not(getPath(frame, path), undefined, path)
  t.is(frame.versions.dht, '0')
  t.ok(['healthy', 'at-risk', 'blocked', 'unknown'].includes(frame.reachability.verdict))
})

test('a read records no history; an emit does, and dedups the next identical frame', async (t) => {
  const emitted = []
  status(t, { ipc: { emit: (name, frame) => emitted.push([name, frame]) } })
  getSwarmStatus()
  t.alike(getVerdictHistory(), [], 'asking for the status is not a transition')

  scheduleStatusEmit()
  scheduleStatusEmit()
  await delay(350)
  t.is(emitted.length, 1, 'two schedules inside the debounce emit once')
  t.is(emitted[0][0], 'event:network-status')
  t.is(getVerdictHistory().length, 1, 'the emitted verdict is the first history entry')

  scheduleStatusEmit()
  await delay(350)
  t.is(emitted.length, 1, 'an unchanged frame is not re-emitted')
})
