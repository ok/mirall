import test from 'brittle'
import b4a from 'b4a'
import Hyperdrive from 'hyperdrive'
import createTestnet from 'hyperdht/testnet.js'
import { setupPeer, teardownPeer, serve, consume } from './_holepunch.js'

test('CRIT-3: nested keys replicate and a subtree is enumerable on the reader', async (t) => {
  const testnet = await createTestnet(3, { teardown: t.teardown })

  const writer = await setupPeer(testnet, 'nested-writer')
  const reader = await setupPeer(testnet, 'nested-reader')
  t.teardown(() => teardownPeer(writer))
  t.teardown(() => teardownPeer(reader))

  const driveA = new Hyperdrive(writer.store)
  await driveA.ready()
  const deep = b4a.from('deeply nested content')
  await driveA.put('/a/b/c.txt', deep)
  await driveA.put('/a/b/d.txt', b4a.from('sibling in same subfolder'))
  await driveA.put('/a/e.txt', b4a.from('one level up'))
  await serve(writer, driveA.discoveryKey)

  const driveB = new Hyperdrive(reader.store, driveA.key)
  await driveB.ready()
  consume(reader, driveB.discoveryKey)
  await driveB.update({ wait: true })

  t.alike(await driveB.get('/a/b/c.txt'), deep, 'a deeply nested file replicates byte-exact')

  const subtree = []
  for await (const entry of driveB.list('/a', { recursive: true })) subtree.push(entry.key)
  subtree.sort()
  t.alike(subtree, ['/a/b/c.txt', '/a/b/d.txt', '/a/e.txt'], 'recursive list of /a returns the whole subtree')

  const inner = []
  for await (const entry of driveB.list('/a/b', { recursive: true })) inner.push(entry.key)
  inner.sort()
  t.alike(inner, ['/a/b/c.txt', '/a/b/d.txt'], 'list of the inner subfolder is scoped to it')
})
