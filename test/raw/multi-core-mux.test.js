import test from 'brittle'
import b4a from 'b4a'
import Hyperdrive from 'hyperdrive'
import createTestnet from 'hyperdht/testnet.js'
import { setupPeer, teardownPeer, serve, consume } from './_holepunch.js'

test('CRIT-12: a second drive replicates over an existing connection without joining its topic', async (t) => {
  const testnet = await createTestnet(3, { teardown: t.teardown })

  const writer = await setupPeer(testnet, 'mux-writer')
  const reader = await setupPeer(testnet, 'mux-reader')
  t.teardown(() => teardownPeer(writer))
  t.teardown(() => teardownPeer(reader))

  const ownerDrive = new Hyperdrive(writer.store.namespace('owner'))
  const peerDrive = new Hyperdrive(writer.store.namespace('peer'))
  await ownerDrive.ready()
  await peerDrive.ready()
  const ownerPayload = b4a.from('owner drive content')
  const peerPayload = b4a.from('peer drive content reached via the same connection')
  await ownerDrive.put('/owner.txt', ownerPayload)
  await peerDrive.put('/peer.txt', peerPayload)

  await serve(writer, ownerDrive.discoveryKey)

  const ownerMirror = new Hyperdrive(reader.store, ownerDrive.key)
  await ownerMirror.ready()
  consume(reader, ownerMirror.discoveryKey)
  await ownerMirror.update({ wait: true })

  t.alike(await ownerMirror.get('/owner.txt'), ownerPayload, 'the joined drive replicates')

  const peerMirror = new Hyperdrive(reader.store, peerDrive.key)
  await peerMirror.ready()
  await peerMirror.update({ wait: true })

  t.alike(
    await peerMirror.get('/peer.txt'),
    peerPayload,
    'a second drive opened from its key replicates over the same connection, without joining its discovery topic'
  )
})
