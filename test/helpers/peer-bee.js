import b4a from 'b4a'
import os from 'bare-os'
import fs from 'bare-fs'
import path from 'bare-path'
import Corestore from 'corestore'
import Hyperbee from 'hyperbee'

function tmpDir () {
  const dir = path.join(os.tmpdir(), `pb-peer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

// Async-capable poll: pred may return a value or a promise.
export async function waitFor (pred, ms = 5000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await pred()) return true
    await new Promise((r) => setTimeout(r, 20))
  }
  return await pred()
}

// A standalone "peer": its own Corestore + a plain (unencrypted, like real profile bees)
// membership bee, replicated into the local store so openProfileBee(peerKey) can read it.
export async function makePeer (t) {
  const dir = tmpDir()
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

export function replicate (a, b, t) {
  const s1 = a.replicate(true)
  const s2 = b.replicate(false)
  s1.on('error', () => {})
  s2.on('error', () => {})
  s1.pipe(s2).pipe(s1)
  const destroy = () => { try { s1.destroy() } catch {}; try { s2.destroy() } catch {} }
  t.teardown(destroy)
  return { s1, s2, destroy }
}
