import test from 'brittle'
import b4a from 'b4a'
import Hyperdrive from 'hyperdrive'
import createTestnet from 'hyperdht/testnet.js'
import { setupPeer, teardownPeer, serve, consume, eventually } from './_holepunch.js'

test('CRIT-5: a move (del old + put new) converges to only the new path on the reader', async (t) => {
  const testnet = await createTestnet(3, { teardown: t.teardown })

  const writer = await setupPeer(testnet, 'move-writer')
  const reader = await setupPeer(testnet, 'move-reader')
  t.teardown(() => teardownPeer(writer))
  t.teardown(() => teardownPeer(reader))

  const driveA = new Hyperdrive(writer.store)
  await driveA.ready()
  const payload = b4a.from('content that moves into a subfolder')
  await driveA.put('/old.txt', payload)
  await serve(writer, driveA.discoveryKey)

  const driveB = new Hyperdrive(reader.store, driveA.key)
  await driveB.ready()
  consume(reader, driveB.discoveryKey)
  await driveB.update({ wait: true })

  t.alike(await driveB.get('/old.txt'), payload, 'file present at original path')
  t.is(await driveB.entry('/sub/new.txt'), null, 'destination path empty before move')

  await driveA.del('/old.txt')
  await driveA.put('/sub/new.txt', payload)

  const converged = await eventually(async () => {
    await driveB.update().catch(() => {})
    const moved = await driveB.get('/sub/new.txt')
    const oldGone = (await driveB.entry('/old.txt')) === null
    return moved && b4a.equals(moved, payload) && oldGone ? true : null
  })

  t.ok(converged, 'reader ends with only the new path populated')
  t.alike(await driveB.get('/sub/new.txt'), payload, 'moved file is byte-exact at the new path')
  t.is(await driveB.entry('/old.txt'), null, 'old path is gone on the reader')
})
