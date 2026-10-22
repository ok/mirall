import test from 'brittle'
import { inHeldOrder } from '../../src/renderer/model/held-order.js'

const spaces = (...ids) => ids.map((spaceId) => ({ spaceId }))
const ids = (list) => list.map((s) => s.spaceId)

test('nothing held keeps the arriving order', (t) => {
  t.alike(ids(inHeldOrder(spaces('b', 'a'), null)), ['b', 'a'])
})

test('a held order wins over a re-sort that arrives while the grid is in use', (t) => {
  t.alike(ids(inHeldOrder(spaces('c', 'a', 'b'), ['a', 'b', 'c'])), ['a', 'b', 'c'])
})

test('a new space goes last and a gone one drops out', (t) => {
  t.alike(ids(inHeldOrder(spaces('new', 'b', 'a'), ['a', 'gone', 'b'])), ['a', 'b', 'new'])
})

test('each held card carries the data that just arrived', (t) => {
  const fresh = [{ spaceId: 'a', lastActivity: 2 }]
  t.is(inHeldOrder(fresh, ['a'])[0], fresh[0])
})
