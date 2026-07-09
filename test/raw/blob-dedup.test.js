import test from 'brittle'
import b4a from 'b4a'
import Hyperdrive from 'hyperdrive'
import createTestnet from 'hyperdht/testnet.js'
import { setupPeer, teardownPeer, serve, consume, patterned } from './_holepunch.js'

test('CRIT-4: identical content is not auto-deduplicated, but both paths replicate byte-exact', async (t) => {
  const testnet = await createTestnet(3, { teardown: t.teardown })

  const writer = await setupPeer(testnet, 'dedup-writer')
  const reader = await setupPeer(testnet, 'dedup-reader')
  t.teardown(() => teardownPeer(writer))
  t.teardown(() => teardownPeer(reader))

  const driveA = new Hyperdrive(writer.store)
  await driveA.ready()
  const payload = patterned(128 * 1024, 1)

  await driveA.put('/original.bin', payload)
  const blobs = await driveA.getBlobs()
  const blocksAfterFirst = blobs.core.length

  await driveA.put('/copy.bin', payload)
  const blocksAfterSecond = blobs.core.length

  t.ok(
    blocksAfterSecond > blocksAfterFirst,
    'copying identical bytes appends fresh blob blocks — Hyperdrive does not content-dedup, so dedup is the app layer\'s job'
  )

  await serve(writer, driveA.discoveryKey)

  const driveB = new Hyperdrive(reader.store, driveA.key)
  await driveB.ready()
  consume(reader, driveB.discoveryKey)
  await driveB.update({ wait: true })

  t.alike(await driveB.get('/original.bin'), payload, 'original path replicates byte-exact')
  t.alike(await driveB.get('/copy.bin'), payload, 'duplicate path replicates byte-exact')
})
