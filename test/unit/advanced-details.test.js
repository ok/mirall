import test from 'brittle'
import { advancedSections, advancedDetailsText } from '../../src/renderer/model/advanced-details.js'

const KEY = 'ab'.repeat(32)
const t = (key, values) => (values && 'count' in values ? `${key}:${values.count}` : key)

const status = (over = {}) => ({
  peerCount: 3,
  topics: 4,
  lastConnectionAt: null,
  dhtReady: true,
  identity: { publicKey: KEY, nodeId: null },
  address: { publicHost: '203.0.113.7', publicPort: 51624, localPort: 51624 },
  nat: { firewalled: true, randomized: false, ephemeral: null },
  routing: { bootstrap: ['node1:49737', 'node2:49737'], tableSize: 214 },
  relay: { connections: [], seen: 2 },
  stats: { relaying: { successes: 1, attempts: 4, aborts: 0, selected: 1 } },
  canary: { state: 'reachable', at: 0, stage1: { announceRecords: 3 } },
  versions: { dht: '6.34.0' },
  ...over,
})

const rowsOf = (sections, key) => sections.find((s) => s.key === key).rows

test('the six sections are derived in the order the screen renders them', (t2) => {
  const sections = advancedSections(status(), 0, t)
  t2.alike(sections.map((s) => s.key), ['connection', 'address', 'nat', 'relaying', 'dht', 'canary'])
})

test('port preservation is positive only when the public and local ports agree', (t2) => {
  const preserved = rowsOf(advancedSections(status(), 0, t), 'address')[3]
  t2.is(preserved.positive, true)
  t2.is(preserved.value, 'networkStatus.portPreservedYes')

  const moved = status({ address: { publicHost: '203.0.113.7', publicPort: 51624, localPort: 9999 } })
  const row = rowsOf(advancedSections(moved, 0, t), 'address')[3]
  t2.is(row.positive, false)
  t2.is(row.value, 'networkStatus.portPreservedNo')
})

test('a port the frame does not carry reads as a dash, not as zero', (t2) => {
  const blank = status({ address: { publicHost: null, publicPort: 0, localPort: 0 } })
  const rows = rowsOf(advancedSections(blank, 0, t), 'address')
  t2.is(rows[1].value, '—')
  t2.is(rows[2].value, '—')
})

test('a bulk copy masks what the screen masks', (t2) => {
  const text = advancedDetailsText(advancedSections(status(), 0, t))
  t2.absent(text.includes(KEY), 'the public key is not copied in full')
  t2.absent(text.includes('203.0.113.7'), 'the public IP is not copied in full')
  t2.ok(text.includes(`•••••••• ${KEY.slice(-6)}`), 'the key copies with the same visible suffix the row shows')
})

test('a bulk copy carries every row of every section, and the bootstrap list in full', (t2) => {
  const sections = advancedSections(status(), 0, t)
  const text = advancedDetailsText(sections)
  const lines = text.split('\n').filter((line) => line.startsWith('  '))
  t2.is(lines.length, sections.reduce((n, s) => n + s.rows.length, 0))
  t2.ok(text.includes('node1:49737, node2:49737'))
})

test('a boolean the frame reports as unknown reads as a dash', (t2) => {
  const rows = rowsOf(advancedSections(status(), 0, t), 'nat')
  t2.is(rows[0].value, 'networkStatus.boolYes')
  t2.is(rows[1].value, 'networkStatus.boolNo')
  t2.is(rows[2].value, '—')
})
