import b4a from 'b4a'
import fs from 'bare-fs'
import Corestore from 'corestore'
import Hyperbee from 'hyperbee'
import { tmpDir } from './bare-tmp.js'
import { until } from './bare-poll.js'

// Async-capable poll: pred may return a value or a promise.
export const waitFor = (pred, ms = 5000) => until(pred, ms, { interval: 20, scale: false })

// A standalone "peer": its own Corestore + a plain (unencrypted, like real profile bees)
// membership bee, replicated into the local store so openProfileBee(peerKey) can read it.
export async function makePeer(t) {
  const dir = tmpDir('pb-peer')
  const store = new Corestore(dir)
  await store.ready()
  const core = store.get({ name: 'profile' })
  await core.ready()
  const bee = new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'json' })
  await bee.put('caps/membership-manifest', true)
  const key = b4a.toString(core.key, 'hex')
  t.teardown(async () => {
    try { await store.close() } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  })
  return { store, bee, key }
}

export function replicate(a, b, t) {
  const s1 = a.replicate(true)
  const s2 = b.replicate(false)
  s1.on('error', () => {})
  s2.on('error', () => {})
  s1.pipe(s2).pipe(s1)
  const destroy = () => { try { s1.destroy() } catch {}; try { s2.destroy() } catch {} }
  t.teardown(destroy)
  return { s1, s2, destroy }
}
