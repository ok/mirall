import test from 'brittle'
import { mergeOptimistic } from '../../src/renderer/optimisticRows.js'

const row = (path, status = 'available') => ({ path, status })

test('an optimistic row shows while the server does not know the path', (t) => {
  const merged = mergeOptimistic([row('/a')], [row('/b', 'publishing')])
  t.alike(merged.map((r) => r.path), ['/b', '/a'], 'pending rows lead')
})

test('an optimistic row is dropped once the server surfaces the same path', (t) => {
  // The worker advertises a file while it is still hashing, so the server row appears BEFORE the
  // publish finishes. Without this the file would render twice.
  const merged = mergeOptimistic([row('/a'), row('/b', 'publishing')], [row('/b', 'publishing')])
  t.alike(merged.map((r) => r.path), ['/a', '/b'], 'no duplicate row')
  t.is(merged.length, 2)
})

test('the server list is returned unchanged when nothing is pending', (t) => {
  const server = [row('/a'), row('/b')]
  t.is(mergeOptimistic(server, []), server, 'same reference — React skips the subtree')
  t.is(mergeOptimistic(server, [row('/a', 'publishing')]), server,
    'and also when every pending row is already known')
})

test('server row order is preserved', (t) => {
  const merged = mergeOptimistic([row('/c'), row('/a'), row('/b')], [row('/z', 'publishing')])
  t.alike(merged.map((r) => r.path), ['/z', '/c', '/a', '/b'])
})
