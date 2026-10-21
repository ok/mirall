import test from 'brittle'
import { shortcutOrder } from '../../src/renderer/model/space-shortcut-order.js'

const space = (spaceId, created, over = {}) => ({ spaceId, created, favorite: false, lastActivity: 0, ...over })
const ids = (spaces) => spaces.map((s) => s.spaceId)

test('favorites come first, then the oldest created or joined', (t) => {
  const spaces = [
    space('new', '2026-10-01T00:00:00Z'),
    space('old', '2026-01-01T00:00:00Z'),
    space('fav-new', '2026-09-01T00:00:00Z', { favorite: true }),
    space('fav-old', '2026-02-01T00:00:00Z', { favorite: true }),
  ]
  t.alike(ids(shortcutOrder(spaces)), ['fav-old', 'fav-new', 'old', 'new'])
})

test('activity never moves a digit', (t) => {
  const quiet = [space('a', '2026-01-01T00:00:00Z', { lastActivity: 1 }), space('b', '2026-02-01T00:00:00Z', { lastActivity: 2 })]
  const busy = [space('b', '2026-02-01T00:00:00Z', { lastActivity: 99 }), space('a', '2026-01-01T00:00:00Z', { lastActivity: 1 })]
  t.alike(ids(shortcutOrder(quiet)), ids(shortcutOrder(busy)))
})

test('a new space goes last and leaves the existing digits in place', (t) => {
  const before = [space('a', '2026-01-01T00:00:00Z'), space('b', '2026-02-01T00:00:00Z')]
  const after = [space('c', '2026-10-21T00:00:00Z'), ...before]
  t.alike(ids(shortcutOrder(after)), ['a', 'b', 'c'])
})

test('the input is not reordered in place', (t) => {
  const spaces = [space('b', '2026-02-01T00:00:00Z'), space('a', '2026-01-01T00:00:00Z')]
  shortcutOrder(spaces)
  t.alike(ids(spaces), ['b', 'a'])
})
