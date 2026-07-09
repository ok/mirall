import test from 'brittle'
import b4a from 'b4a'
import Hyperdrive from 'hyperdrive'
import createTestnet from 'hyperdht/testnet.js'
import { setupPeer, teardownPeer, serve, join } from './_holepunch.js'

test('CRIT-11: one drive fans out to two readers, and a reader seeds onward when the owner is offline', async (t) => {
  const testnet = await createTestnet(3, { teardown: t.teardown })

  const writer = await setupPeer(testnet, 'fanout-writer')
  const readerB = await setupPeer(testnet, 'fanout-reader-b')
  const readerC = await setupPeer(testnet, 'fanout-reader-c')
  t.teardown(() => teardownPeer(writer))
  t.teardown(() => teardownPeer(readerB))
  t.teardown(() => teardownPeer(readerC))

  const driveA = new Hyperdrive(writer.store)
  await driveA.ready()
  const payload = b4a.from('shared by the owner, then re-served by a peer')
  await driveA.put('/shared.txt', payload)
  await serve(writer, driveA.discoveryKey)

  const driveB = new Hyperdrive(readerB.store, driveA.key)
  await driveB.ready()
  join(readerB, driveB.discoveryKey)
  await driveB.update({ wait: true })

  t.alike(await driveB.get('/shared.txt'), payload, 'first reader downloads from the owner')
  t.ok(await driveB.has('/shared.txt'), 'first reader has fully cached the blob')

  await writer.swarm.destroy()

  const driveC = new Hyperdrive(readerC.store, driveA.key)
  await driveC.ready()
  join(readerC, driveC.discoveryKey)
  await driveC.update({ wait: true })

  const got = await driveC.get('/shared.txt')
  t.ok(got, 'second reader obtains the file with the owner offline')
  t.alike(got, payload, 'onward-seeded bytes are exact')
})
