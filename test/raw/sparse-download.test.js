import test from 'brittle'
import Hyperdrive from 'hyperdrive'
import createTestnet from 'hyperdht/testnet.js'
import { setupPeer, teardownPeer, serve, consume, patterned } from './_holepunch.js'

test('CRIT-7: a reader downloads only the blob it asks for, not the whole drive', async (t) => {
  const testnet = await createTestnet(3, { teardown: t.teardown })

  const writer = await setupPeer(testnet, 'sparse-writer')
  const reader = await setupPeer(testnet, 'sparse-reader')
  t.teardown(() => teardownPeer(writer))
  t.teardown(() => teardownPeer(reader))

  const driveA = new Hyperdrive(writer.store)
  await driveA.ready()
  const wanted = patterned(96 * 1024, 1)
  const other = patterned(96 * 1024, 2)
  await driveA.put('/wanted.bin', wanted)
  await driveA.put('/other.bin', other)
  await serve(writer, driveA.discoveryKey)

  const driveB = new Hyperdrive(reader.store, driveA.key)
  await driveB.ready()
  consume(reader, driveB.discoveryKey)
  await driveB.update({ wait: true })

  t.absent(await driveB.has('/wanted.bin'), 'no blob cached after a metadata-only update')
  t.absent(await driveB.has('/other.bin'), 'no blob cached after a metadata-only update')

  t.alike(await driveB.get('/wanted.bin'), wanted, 'requested file downloads byte-exact')

  t.ok(await driveB.has('/wanted.bin'), 'requested blob is now cached locally')
  t.absent(await driveB.has('/other.bin'), 'the un-requested blob was never transferred (sparse)')
})
