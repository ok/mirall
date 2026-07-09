import test from 'brittle'
import b4a from 'b4a'
import Hyperdrive from 'hyperdrive'
import createTestnet from 'hyperdht/testnet.js'
import { setupPeer, teardownPeer, serve, consume } from './_holepunch.js'

test('CRIT-9: an uncached blob is unavailable (no silent success) once the only seeder goes offline', async (t) => {
  const testnet = await createTestnet(3, { teardown: t.teardown })

  const writer = await setupPeer(testnet, 'offline-writer')
  const reader = await setupPeer(testnet, 'offline-reader')
  t.teardown(() => teardownPeer(writer))
  t.teardown(() => teardownPeer(reader))

  const driveA = new Hyperdrive(writer.store)
  await driveA.ready()
  const payload = b4a.from('only the owner has these bytes')
  await driveA.put('/file.txt', payload)
  await serve(writer, driveA.discoveryKey)

  const driveB = new Hyperdrive(reader.store, driveA.key)
  await driveB.ready()
  consume(reader, driveB.discoveryKey)
  await driveB.update({ wait: true })

  t.ok(await driveB.entry('/file.txt'), 'reader synced the entry metadata while the owner was online')
  t.absent(await driveB.has('/file.txt'), 'reader has not cached the blob (sparse)')

  await writer.swarm.destroy()

  await t.exception(
    driveB.get('/file.txt', { wait: false }),
    /BLOCK_NOT_AVAILABLE/,
    'a non-waiting get throws rather than silently returning nothing once the seeder is gone'
  )
  t.absent(await driveB.has('/file.txt'), 'blob is still uncached while the owner is offline')
})
