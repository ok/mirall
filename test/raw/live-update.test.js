import test from 'brittle'
import b4a from 'b4a'
import Hyperdrive from 'hyperdrive'
import createTestnet from 'hyperdht/testnet.js'
import { setupPeer, teardownPeer, serve, consume, eventually } from './_holepunch.js'

test('CRIT-1: a reader receives writes made after its initial sync (live replication)', async (t) => {
  const testnet = await createTestnet(3, { teardown: t.teardown })

  const writer = await setupPeer(testnet, 'live-writer')
  const reader = await setupPeer(testnet, 'live-reader')
  t.teardown(() => teardownPeer(writer))
  t.teardown(() => teardownPeer(reader))

  const driveA = new Hyperdrive(writer.store)
  await driveA.ready()
  const first = b4a.from('first write, present at initial sync')
  await driveA.put('/first.txt', first)
  await serve(writer, driveA.discoveryKey)

  const driveB = new Hyperdrive(reader.store, driveA.key)
  await driveB.ready()
  consume(reader, driveB.discoveryKey)
  await driveB.update({ wait: true })

  t.alike(await driveB.get('/first.txt'), first, 'initial file present after first sync')

  const second = b4a.from('second write, made while the reader stays joined')
  await driveA.put('/second.txt', second)

  const got = await eventually(async () => {
    await driveB.update().catch(() => {})
    const v = await driveB.get('/second.txt')
    return v && b4a.equals(v, second) ? v : null
  })

  t.ok(got, 'reader observed a post-sync write without re-joining or re-issuing update({wait:true})')
  t.alike(got, second, 'late write replicated byte-exact')
})
