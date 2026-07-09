import test from 'brittle'
import Hyperbee from 'hyperbee'
import createTestnet from 'hyperdht/testnet.js'
import { setupPeer, teardownPeer, serve, consume, eventually } from './_holepunch.js'

test('CRIT-10: a Hyperbee del and an overwriting put both replicate (not first-write-wins)', async (t) => {
  const testnet = await createTestnet(3, { teardown: t.teardown })

  const writer = await setupPeer(testnet, 'bee-mut-writer')
  const reader = await setupPeer(testnet, 'bee-mut-reader')
  t.teardown(() => teardownPeer(writer))
  t.teardown(() => teardownPeer(reader))

  const coreA = writer.store.get({ name: 'registry' })
  const beeA = new Hyperbee(coreA, { keyEncoding: 'utf-8', valueEncoding: 'json' })
  await beeA.ready()
  await beeA.put('k1', 'v1')
  await beeA.put('k2', 'v2')
  await serve(writer, coreA.discoveryKey)

  const coreB = reader.store.get({ key: coreA.key })
  await coreB.ready()
  const beeB = new Hyperbee(coreB, { keyEncoding: 'utf-8', valueEncoding: 'json' })
  await beeB.ready()
  consume(reader, coreB.discoveryKey)
  await coreB.update({ wait: true })

  t.is((await beeB.get('k1'))?.value, 'v1', 'first key replicated')
  t.is((await beeB.get('k2'))?.value, 'v2', 'second key replicated')

  await beeA.del('k1')
  await beeA.put('k2', 'v2-updated')

  const converged = await eventually(async () => {
    await coreB.update().catch(() => {})
    const k1 = await beeB.get('k1')
    const k2 = await beeB.get('k2')
    return k1 === null && k2?.value === 'v2-updated' ? true : null
  })

  t.ok(converged, 'reader observes the delete and the overwrite')
  t.is(await beeB.get('k1'), null, 'deleted key reads null on the reader')
  t.is((await beeB.get('k2'))?.value, 'v2-updated', 'overwritten value replaces the original')
})
