import test from 'brittle'
import Hyperdrive from 'hyperdrive'
import createTestnet from 'hyperdht/testnet.js'
import { setupPeer, teardownPeer, serve, consume, patterned } from './_holepunch.js'

test('CRIT-13: clearing a cached blob on the reader drops it from local storage', async (t) => {
  const testnet = await createTestnet(3, { teardown: t.teardown })

  const writer = await setupPeer(testnet, 'clear-writer')
  const reader = await setupPeer(testnet, 'clear-reader')
  t.teardown(() => teardownPeer(writer))
  t.teardown(() => teardownPeer(reader))

  const driveA = new Hyperdrive(writer.store)
  await driveA.ready()
  const payload = patterned(128 * 1024, 5)
  await driveA.put('/cached.bin', payload)
  await serve(writer, driveA.discoveryKey)

  const driveB = new Hyperdrive(reader.store, driveA.key)
  await driveB.ready()
  consume(reader, driveB.discoveryKey)
  await driveB.update({ wait: true })

  t.alike(await driveB.get('/cached.bin'), payload, 'reader downloads and caches the blob')
  t.ok(await driveB.has('/cached.bin'), 'blob is cached locally before clear')

  const entry = await driveB.entry('/cached.bin')
  const blobs = await driveB.getBlobs()
  t.ok(await blobs.core.has(entry.value.blob.blockOffset), 'first blob block present before clear')

  await driveB.clear('/cached.bin')

  t.absent(await driveB.has('/cached.bin'), 'blob is no longer cached after clear')
  t.absent(await blobs.core.has(entry.value.blob.blockOffset), 'underlying blob blocks were reclaimed')
})
