import test from 'brittle'
import { mergeOptimistic } from '../../src/renderer/model/optimistic-rows.js'

const row = (path, status = 'mine') => ({ path, status })
const paths = (rows) => rows.map((r) => r.path)

test('an optimistic row shows while the server does not know the path', (t) => {
  const merged = mergeOptimistic([row('/b')], [row('/a', 'queued')])
  t.alike(paths(merged), ['/a', '/b'])
})

test('REGRESSION (FIX-639: optimistic rows led the list, so each jumped to its name slot on the next listing) — a pending row sits where the server will list it', (t) => {
  const merged = mergeOptimistic([row('/a.txt'), row('/z.txt')], [row('/m.mov', 'queued')])
  t.alike(paths(merged), ['/a.txt', '/m.mov', '/z.txt'], 'among own rows, in name order')
})

test('REGRESSION (FIX-639: a batch sorted below the file being hashed) — pending rows of one add sort by name, not drop order', (t) => {
  const server = [row('/a.mov', 'publishing'), row('/notes.txt')]
  const merged = mergeOptimistic(server, [row('/c.mov', 'queued'), row('/b.mov', 'queued')])
  t.alike(paths(merged), ['/a.mov', '/b.mov', '/c.mov', '/notes.txt'])
})

test('a pending row past every own row lands before the first peer row', (t) => {
  const server = [row('/a.txt'), row('/b.txt', 'queued'), row('/0-peer.txt', 'remote'), row('/peer.txt', 'downloaded')]
  const merged = mergeOptimistic(server, [row('/x.mov', 'queued')])
  t.alike(paths(merged), ['/a.txt', '/b.txt', '/x.mov', '/0-peer.txt', '/peer.txt'])
})

test('with no own rows, pending rows lead the peer rows', (t) => {
  const merged = mergeOptimistic([row('/a.txt', 'remote')], [row('/z.mov', 'queued')])
  t.alike(paths(merged), ['/z.mov', '/a.txt'])
})

test('names compare by code point, the catalog key order', (t) => {
  // UTF-16 puts the surrogate pair of U+1F600 before U+FF21; UTF-8 bytes and code points do not.
  const merged = mergeOptimistic([row('/Ａ.txt')], [row('/\u{1F600}.txt', 'queued')])
  t.alike(paths(merged), ['/Ａ.txt', '/\u{1F600}.txt'])
})

test('an optimistic row is dropped once the server surfaces the same path', (t) => {
  // The worker advertises a file while it is still hashing, so the server row appears BEFORE the
  // publish finishes. Without this the file would render twice.
  const merged = mergeOptimistic([row('/a'), row('/b', 'publishing')], [row('/b', 'queued')])
  t.alike(paths(merged), ['/a', '/b'], 'no duplicate row')
  t.is(merged.length, 2)
})

test('the server list is returned unchanged when nothing is pending', (t) => {
  const server = [row('/a'), row('/b')]
  t.is(mergeOptimistic(server, []), server, 'same reference — React skips the subtree')
  t.is(mergeOptimistic(server, [row('/a', 'queued')]), server,
    'and also when every pending row is already known')
})

test('server row order is preserved', (t) => {
  const merged = mergeOptimistic([row('/c'), row('/a'), row('/b', 'remote')], [row('/z', 'queued')])
  t.alike(paths(merged), ['/c', '/a', '/z', '/b'])
})
