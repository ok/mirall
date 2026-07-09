import test from 'brittle'
import b4a from 'b4a'
import Hyperdrive from 'hyperdrive'
import createTestnet from 'hyperdht/testnet.js'
import { setupPeer, teardownPeer, serve, consume, eventually } from './_holepunch.js'

test('CRIT-6: recursive subtree deletion replicates without touching sibling keys', async (t) => {
  const testnet = await createTestnet(3, { teardown: t.teardown })

  const writer = await setupPeer(testnet, 'subtree-writer')
  const reader = await setupPeer(testnet, 'subtree-reader')
  t.teardown(() => teardownPeer(writer))
  t.teardown(() => teardownPeer(reader))

  const driveA = new Hyperdrive(writer.store)
  await driveA.ready()
  const inside = b4a.from('inside the doomed subtree')
  const sibling = b4a.from('shares a prefix string but not the folder boundary')
  const keep = b4a.from('unrelated file')
  await driveA.put('/dir/a.txt', inside)
  await driveA.put('/dir/sub/b.txt', inside)
  await driveA.put('/dirsibling.txt', sibling)
  await driveA.put('/keep.txt', keep)
  await serve(writer, driveA.discoveryKey)

  const driveB = new Hyperdrive(reader.store, driveA.key)
  await driveB.ready()
  consume(reader, driveB.discoveryKey)
  await driveB.update({ wait: true })

  t.alike(await driveB.get('/dir/a.txt'), inside, 'subtree file present before delete')
  t.alike(await driveB.get('/dirsibling.txt'), sibling, 'prefix-sibling present before delete')

  for await (const entry of driveA.list('/dir', { recursive: true })) await driveA.del(entry.key)

  const cleared = await eventually(async () => {
    await driveB.update().catch(() => {})
    const a = await driveB.entry('/dir/a.txt')
    const b = await driveB.entry('/dir/sub/b.txt')
    return a === null && b === null ? true : null
  })

  t.ok(cleared, 'every key under the deleted folder is gone on the reader')
  t.alike(await driveB.get('/dirsibling.txt'), sibling, 'prefix-sibling outside the folder boundary survives')
  t.alike(await driveB.get('/keep.txt'), keep, 'unrelated file survives')
})
