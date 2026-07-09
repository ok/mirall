import test from 'brittle'
import os from 'os'
import path from 'path'
import fs from 'fs'
import b4a from 'b4a'
import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'
import Hyperbee from 'hyperbee'
import Hyperswarm from 'hyperswarm'
import createTestnet from 'hyperdht/testnet.js'

function tmpDir(label) {
  const dir = path.join(os.tmpdir(), `mirall-test-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

async function setupPeer(testnet, label) {
  const dir = tmpDir(label)
  const store = new Corestore(dir)
  await store.ready()
  const swarm = new Hyperswarm({ bootstrap: testnet.bootstrap })
  swarm.on('connection', socket => store.replicate(socket))
  return { dir, store, swarm }
}

async function teardownPeer(peer) {
  await peer.swarm.destroy()
  await peer.store.close()
  fs.rmSync(peer.dir, { recursive: true, force: true })
}

test('hyperdrive replicates a file over hyperswarm via corestore', async (t) => {
  const testnet = await createTestnet(3, { teardown: t.teardown })

  const writer = await setupPeer(testnet, 'writer')
  const reader = await setupPeer(testnet, 'reader')
  t.teardown(() => teardownPeer(writer))
  t.teardown(() => teardownPeer(reader))

  const driveA = new Hyperdrive(writer.store)
  await driveA.ready()

  const payload = b4a.from('hello from holepunch integration test')
  await driveA.put('/greeting.txt', payload)

  writer.swarm.join(driveA.discoveryKey, { server: true, client: false })
  await writer.swarm.flush()

  const driveB = new Hyperdrive(reader.store, driveA.key)
  await driveB.ready()

  const done = driveB.findingPeers()
  reader.swarm.join(driveB.discoveryKey, { server: false, client: true })
  reader.swarm.flush().then(done)

  await driveB.update({ wait: true })

  const got = await driveB.get('/greeting.txt')
  t.ok(got, 'reader retrieved entry from peer drive')
  t.alike(got, payload, 'file content matches across peers')
})

test('hyperbee replicates ordered key/value writes over hyperswarm', async (t) => {
  const testnet = await createTestnet(3, { teardown: t.teardown })

  const writer = await setupPeer(testnet, 'bee-writer')
  const reader = await setupPeer(testnet, 'bee-reader')
  t.teardown(() => teardownPeer(writer))
  t.teardown(() => teardownPeer(reader))

  const coreA = writer.store.get({ name: 'profile' })
  const beeA = new Hyperbee(coreA, { keyEncoding: 'utf-8', valueEncoding: 'json' })
  await beeA.ready()

  await beeA.put('displayName', 'alice')
  await beeA.put('avatar', 'avatar-blob-key')

  writer.swarm.join(coreA.discoveryKey, { server: true, client: false })
  await writer.swarm.flush()

  const coreB = reader.store.get({ key: coreA.key })
  await coreB.ready()
  const beeB = new Hyperbee(coreB, { keyEncoding: 'utf-8', valueEncoding: 'json' })
  await beeB.ready()

  const done = reader.store.findingPeers()
  reader.swarm.join(coreB.discoveryKey, { server: false, client: true })
  reader.swarm.flush().then(done)

  await coreB.update({ wait: true })

  const name = await beeB.get('displayName')
  const avatar = await beeB.get('avatar')

  t.is(name?.value, 'alice', 'string value replicated')
  t.is(avatar?.value, 'avatar-blob-key', 'second key replicated')
})

test('namespaced corestore drives have distinct keys and replicate independently', async (t) => {
  const testnet = await createTestnet(3, { teardown: t.teardown })

  const writer = await setupPeer(testnet, 'ns-writer')
  const reader = await setupPeer(testnet, 'ns-reader')
  t.teardown(() => teardownPeer(writer))
  t.teardown(() => teardownPeer(reader))

  const driveOne = new Hyperdrive(writer.store.namespace('space-one'))
  const driveTwo = new Hyperdrive(writer.store.namespace('space-two'))
  await driveOne.ready()
  await driveTwo.ready()

  t.unlike(driveOne.key, driveTwo.key, 'namespaces produce distinct drive keys')

  await driveOne.put('/a.txt', b4a.from('one'))
  await driveTwo.put('/b.txt', b4a.from('two'))

  writer.swarm.join(driveOne.discoveryKey, { server: true, client: false })
  writer.swarm.join(driveTwo.discoveryKey, { server: true, client: false })
  await writer.swarm.flush()

  const mirrorOne = new Hyperdrive(reader.store, driveOne.key)
  const mirrorTwo = new Hyperdrive(reader.store, driveTwo.key)
  await mirrorOne.ready()
  await mirrorTwo.ready()

  const done = reader.store.findingPeers()
  reader.swarm.join(mirrorOne.discoveryKey, { server: false, client: true })
  reader.swarm.join(mirrorTwo.discoveryKey, { server: false, client: true })
  reader.swarm.flush().then(done)

  await mirrorOne.update({ wait: true })
  await mirrorTwo.update({ wait: true })

  const a = await mirrorOne.get('/a.txt')
  const b = await mirrorTwo.get('/b.txt')

  t.alike(a, b4a.from('one'), 'first namespace drive replicated')
  t.alike(b, b4a.from('two'), 'second namespace drive replicated')
})
