import test from 'brittle'
import b4a from 'b4a'
import Hyperdrive from 'hyperdrive'
import createTestnet from 'hyperdht/testnet.js'
import { setupPeer, teardownPeer, serve, consume, patterned } from './_holepunch.js'

test('CRIT-8: a multi-block blob streams across peers chunk-by-chunk, byte-exact', async (t) => {
  const testnet = await createTestnet(3, { teardown: t.teardown })

  const writer = await setupPeer(testnet, 'stream-writer')
  const reader = await setupPeer(testnet, 'stream-reader')
  t.teardown(() => teardownPeer(writer))
  t.teardown(() => teardownPeer(reader))

  const driveA = new Hyperdrive(writer.store)
  await driveA.ready()
  const payload = patterned(256 * 1024, 3)

  const ws = driveA.createWriteStream('/big.bin')
  const half = payload.length >> 1
  ws.write(payload.subarray(0, half))
  ws.write(payload.subarray(half))
  await new Promise((resolve, reject) => ws.end(err => (err ? reject(err) : resolve())))

  await serve(writer, driveA.discoveryKey)

  const driveB = new Hyperdrive(reader.store, driveA.key)
  await driveB.ready()
  consume(reader, driveB.discoveryKey)
  await driveB.update({ wait: true })

  const entry = await driveB.entry('/big.bin')
  t.ok(entry.value.blob.blockLength > 1, 'the blob genuinely spans multiple blocks')

  const chunks = []
  for await (const chunk of driveB.createReadStream('/big.bin')) chunks.push(chunk)

  t.ok(chunks.length > 1, 'the read stream delivered the blob in multiple chunks')
  t.alike(b4a.concat(chunks), payload, 'the reassembled stream is byte-exact')
})
