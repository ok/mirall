import os from 'os'
import path from 'path'
import fs from 'fs'
import b4a from 'b4a'
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'

export function tmpDir(label) {
  const dir = path.join(os.tmpdir(), `mirall-test-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export async function setupPeer(testnet, label) {
  const dir = tmpDir(label)
  const store = new Corestore(dir)
  await store.ready()
  const swarm = new Hyperswarm({ bootstrap: testnet.bootstrap })
  swarm.on('connection', socket => store.replicate(socket))
  return { dir, store, swarm }
}

export async function teardownPeer(peer) {
  await peer.swarm.destroy()
  await peer.store.close()
  fs.rmSync(peer.dir, { recursive: true, force: true })
}

export function serve(peer, discoveryKey) {
  peer.swarm.join(discoveryKey, { server: true, client: false })
  return peer.swarm.flush()
}

export function consume(peer, discoveryKey) {
  const done = peer.store.findingPeers()
  peer.swarm.join(discoveryKey, { server: false, client: true })
  peer.swarm.flush().then(done, done)
}

export function join(peer, discoveryKey) {
  const done = peer.store.findingPeers()
  peer.swarm.join(discoveryKey)
  peer.swarm.flush().then(done, done)
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function eventually(fn, { timeout = 15000, interval = 50 } = {}) {
  const start = Date.now()
  for (;;) {
    const value = await fn()
    if (value !== null && value !== undefined && value !== false) return value
    if (Date.now() - start > timeout) return null
    await sleep(interval)
  }
}

export function patterned(size, seed = 0) {
  const buf = b4a.alloc(size)
  for (let i = 0; i < size; i++) buf[i] = (i * 31 + seed * 7 + 13) & 0xff
  return buf
}
