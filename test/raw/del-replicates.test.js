import test from 'brittle'
import b4a from 'b4a'
import Hyperdrive from 'hyperdrive'
import createTestnet from 'hyperdht/testnet.js'
import { setupPeer, teardownPeer, serve, consume, eventually } from './_holepunch.js'

test('CRIT-2: a del replicates as an observable tombstone', async (t) => {
  const testnet = await createTestnet(3, { teardown: t.teardown })

  const writer = await setupPeer(testnet, 'del-writer')
  const reader = await setupPeer(testnet, 'del-reader')
  t.teardown(() => teardownPeer(writer))
  t.teardown(() => teardownPeer(reader))

  const driveA = new Hyperdrive(writer.store)
  await driveA.ready()
  const payload = b4a.from('file that will be deleted')
  await driveA.put('/x.txt', payload)
  await serve(writer, driveA.discoveryKey)

  const driveB = new Hyperdrive(reader.store, driveA.key)
  await driveB.ready()
  consume(reader, driveB.discoveryKey)
  await driveB.update({ wait: true })

  t.alike(await driveB.get('/x.txt'), payload, 'file present before delete')

  await driveA.del('/x.txt')

  const gone = await eventually(async () => {
    await driveB.update().catch(() => {})
    return (await driveB.entry('/x.txt')) === null ? true : null
  })

  t.ok(gone, 'reader sees the entry removed after the writer deleted it')
  t.is(await driveB.get('/x.txt'), null, 'get returns null for the deleted path')
})
