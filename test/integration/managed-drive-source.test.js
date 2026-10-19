import test from 'brittle'
import b4a from 'b4a'
import Corestore from 'corestore'
import Hyperbee from 'hyperbee'
import Hyperswarm from 'hyperswarm'
import { localTestnet } from '../helpers/testnet.js'
import { tmpDir } from '../helpers/bare-tmp.js'
import { waitFor } from '../helpers/bare-poll.js'
import { encodeDriveEntry } from '../helpers/managed-seal.js'
import { createTimers } from '../../src/shared/core/timers.js'
import { DriveSource } from '../../src/shared/managed/drive-source.js'

const quiet = { warn: () => {}, info: () => {} }

// The publisher's write path: a named core under a namespace, a binary-valued Hyperbee, one entry
// per profile in the "bundles" sub, served on the DHT.
async function publisher(t, bootstrap) {
  const store = new Corestore(tmpDir('managed-publisher', t))
  const core = store.namespace('drive').get({ name: 'db', exclusive: true })
  await core.ready()
  const bee = new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'binary' })
  await bee.ready()
  const swarm = new Hyperswarm({ bootstrap })
  swarm.on('connection', (socket) => store.replicate(socket))
  swarm.join(core.discoveryKey, { server: true, client: true })
  await swarm.flush()
  t.teardown(async () => { await swarm.destroy(); await bee.close(); await store.close() })
  const put = (profileId, bytes, issuedAt) => bee.sub('bundles').put(profileId, encodeDriveEntry({ issuedAt, bundle: bytes }))
  return { core, bee, put, swarm }
}

async function reader(t, bootstrap, driveKey, changes = []) {
  const timers = createTimers()
  const source = new DriveSource({ dir: tmpDir('managed-reader', t), bootstrap, driveKey, timers, onChange: (why) => changes.push(why), log: quiet })
  t.teardown(async () => { await source.close(); timers.close() })
  await source.open()
  return { source, timers }
}

test('a publish arrives live, an append re-reads, and the newest entry is what is read', async (t) => {
  const bootstrap = await localTestnet(t)
  const pub = await publisher(t, bootstrap)
  await pub.put('p1', b4a.from('first'), 1)
  const changes = []
  const { source } = await reader(t, bootstrap, pub.core.key, changes)
  await waitFor(async () => (await source.readBundles({ timeoutMs: 2000 })).length === 1, 20000, { label: 'the first entry' })
  t.alike((await source.readBundles()).map((b) => b4a.toString(b.bytes)), ['first'])
  await pub.put('p1', b4a.from('second'), 2)
  await waitFor(() => changes.includes('append'), 10000, { label: 'an append' })
  await waitFor(async () => b4a.toString((await source.readBundles())[0].bytes) === 'second', 10000, { label: 'the overwrite' })
  t.ok(source.peers >= 1)
})

test('an entry that is not v1 is skipped, the rest still read', async (t) => {
  const bootstrap = await localTestnet(t)
  const pub = await publisher(t, bootstrap)
  await pub.bee.sub('bundles').put('broken', b4a.from([2, 0, 0]))
  await pub.put('p1', b4a.from('ok'), 1)
  const { source } = await reader(t, bootstrap, pub.core.key)
  await waitFor(async () => (await source.readBundles({ timeoutMs: 2000 })).length === 1, 20000, { label: 'the valid entry' })
  t.alike((await source.readBundles()).map((b) => b.profileId), ['p1'])
})

test('an empty drive reads as nothing, without throwing', async (t) => {
  const bootstrap = await localTestnet(t)
  const pub = await publisher(t, bootstrap)
  const { source } = await reader(t, bootstrap, pub.core.key)
  t.alike(await source.readBundles({ timeoutMs: 500 }), [])
})

test('close releases its swarm, its DHT node and every timer', async (t) => {
  const bootstrap = await localTestnet(t)
  const pub = await publisher(t, bootstrap)
  await pub.put('p1', b4a.from('x'), 1)
  const { source, timers } = await reader(t, bootstrap, pub.core.key)
  await waitFor(async () => (await source.readBundles({ timeoutMs: 2000 })).length === 1, 20000, { label: 'the entry' })
  const swarm = source.swarm
  await source.close()
  t.ok(swarm.destroyed, 'the swarm is destroyed')
  t.ok(swarm.dht.destroyed, 'with its own DHT node')
  t.is(timers.size, 0, 'no timer left armed')
  t.alike(await source.readBundles({ timeoutMs: 100 }), [], 'a closed source reads nothing')
})
