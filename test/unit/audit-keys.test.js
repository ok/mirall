import test from 'brittle'
import { EVT, BY_SPACE, deviceKey, evtKey, evtRange, indexKeyOf, indexRange, pad, seqOf, spaceKey } from '../../src/shared/audit/audit-keys.js'

test('padded seqs sort lexicographically in numeric order', (t) => {
  const seqs = [0, 9, 10, 99, 100, 123456789]
  const keys = seqs.map(evtKey)
  t.alike([...keys].sort(), keys)
  t.alike(keys.map(seqOf), seqs, 'seqOf inverts evtKey')
})

test('the index key follows the space when the record names one', (t) => {
  t.is(indexKeyOf({ seq: 7, space: { id: 'sp1' } }), spaceKey('sp1', 7))
  t.is(indexKeyOf({ seq: 7, space: null }), deviceKey(7))
  t.is(indexKeyOf({ seq: 7, space: { id: '' } }), deviceKey(7))
})

test('a range without a bound covers the whole prefix', (t) => {
  t.alike(evtRange(), { gte: EVT, lt: 'evt0' })
  t.alike(indexRange(BY_SPACE + 'sp1/'), { gte: 'by-space/sp1/', lt: 'by-space/sp10' })
})

test('a bounded range excludes the bound and everything above it', (t) => {
  const range = evtRange(5)
  t.is(range.gte, EVT)
  t.is(range.lt, EVT + pad(5))
  t.ok(evtKey(4) < range.lt)
  t.ok(evtKey(5) >= range.lt)
})
