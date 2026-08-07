import test from 'brittle'
import { statusEqual } from '../../src/shared/transfer/swarm.js'

// statusEqual dedups network-status events: a fresh status equal to the last is not re-emitted.
// It is a flat list of scalar field comparisons; the real refactor risk is dropping or duplicating
// a field, so this builds a representative status and asserts that changing ANY single field — at
// every nesting level — breaks equality. Lives in integration (bare runner) since swarm.js imports
// bare-* modules and won't load under node.

// Every leaf field statusEqual compares; mirrors STATUS_FIELDS in swarm.js.
const FIELD_PATHS = [
  'state', 'dhtReady', 'announced', 'peerCount', 'connecting', 'suspended',
  'lastConnectionAt', 'bootedAt',
  'identity.publicKey', 'identity.nodeId',
  'address.publicHost', 'address.publicPort', 'address.localPort',
  'nat.firewalled', 'nat.randomized', 'nat.ephemeral',
  'routing.tableSize', 'topics', 'stats.updates',
  'stats.connects.client.opened', 'stats.connects.client.closed',
  'stats.connects.server.opened', 'stats.connects.server.closed',
  'stats.bannedPeers',
  'stats.relaying.selected', 'stats.relaying.attempts', 'stats.relaying.successes', 'stats.relaying.aborts',
]

function makeStatus () {
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
  }
}

const clone = (o) => JSON.parse(JSON.stringify(o))
function setPath (obj, path, val) {
  const keys = path.split('.')
  let o = obj
  for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]]
  o[keys.at(-1)] = val
}

test('statusEqual: reference / deep-equal / nullish', (t) => {
  const base = makeStatus()
  t.ok(statusEqual(base, base), 'same reference is equal')
  t.ok(statusEqual(base, clone(base)), 'a deep-equal clone is equal')
  t.absent(statusEqual(base, null), 'b nullish → not equal')
  t.absent(statusEqual(null, base), 'a nullish → not equal')
  t.ok(statusEqual(null, null), 'both null are reference-equal (a === b guard) → equal')
})

test('statusEqual: any single field difference breaks equality (all 28 compared)', (t) => {
  const base = makeStatus()
  for (const path of FIELD_PATHS) {
    const mutated = clone(base)
    setPath(mutated, path, `changed-${path}`)
    t.absent(statusEqual(base, mutated), `differs on ${path}`)
  }
})
