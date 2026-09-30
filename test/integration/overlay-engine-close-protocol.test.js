import test from 'brittle'
import Protomux from 'protomux'
import crypto from 'hypercore-crypto'
import { Duplex } from 'streamx'
import { tmpStore, tmpDir, fs, path } from './overlay-engine-helpers.js'
import { makeOverlay } from '../helpers/overlay-engine.js'
import { scaled } from '../helpers/bare-timing.js'

function makeDuplex() {
  let aWrite, bWrite
  const a = new Duplex({ write(d, cb) { bWrite(d); cb() }, read() {} })
  const b = new Duplex({ write(d, cb) { aWrite(d); cb() }, read() {} })
  aWrite = (d) => a.push(d)
  bWrite = (d) => b.push(d)
  return [a, b]
}

const settle = (ms = 400) => new Promise((r) => setTimeout(r, scaled(ms)))

async function overlay(t, label, opts = {}) {
  const o = makeOverlay(tmpStore(label), { namespace: 'mirall-overlay', ...opts })
  await o.ready()
  t.teardown(async () => { try { await o.close() } catch {} })
  return o
}

function fileOnDisk(label, bytes = 4096) {
  const dir = tmpDir(label)
  const content = crypto.randomBytes(bytes)
  const p = path.join(dir, 'f.bin')
  fs.writeFileSync(p, content)
  return { diskPath: p, contentHash: crypto.data(content).toString('hex'), size: content.byteLength }
}

// The swarm subsystems close before the overlay does, so a swarm teardown must drop the sockets
// while the overlay can still answer from its index — the publish service and the owned-folder
// watcher drain against a live overlay after the network is gone.
test('closeProtocol drops the protocol but leaves the index serving', async (t) => {
  const o = await overlay(t, 'cp-index')
  const early = fileOnDisk('cp-early')
  await o.registerFile(early.diskPath, { contentHash: early.contentHash, size: early.size })

  o.closeProtocol()
  t.is(o.protocol, null, 'the protocol is gone')

  t.is((await o.fetchFile(early.contentHash, {}))?.destPath, early.diskPath, 'what was registered before is still servable')

  const late = fileOnDisk('cp-late')
  const res = await o.registerFile(late.diskPath, { contentHash: late.contentHash, size: late.size })
  t.not(res, null, 'registration still works')
  t.is((await o.fetchFile(late.contentHash, {}))?.destPath, late.diskPath, 'and the registration landed')
  const map = [{ hash: 'h', offset: 0, length: late.size }]
  await o.index.putChunkMapByHash(late.contentHash, map)
  t.alike(await o.index.getChunkMapByHash(late.contentHash), map, 'the index still accepts writes and serves them')

  // registerFile awaits the stack build; the resolved build must satisfy it rather than
  // rebuilding a protocol nobody is holding.
  t.is(o.protocol, null, 'a post-close write does not resurrect the protocol')
})

test('closeProtocol is idempotent and close() still completes after it', async (t) => {
  const o = await overlay(t, 'cp-idem')
  o.closeProtocol()
  o.closeProtocol()
  t.is(o.protocol, null, 'the second call is a no-op')
  await o.close()
  t.pass('close() runs its index teardown with the protocol already gone')
})

// Destroying the protocol is what fires the per-peer teardown; doing it while the sockets are
// still up is what lets the serve-end callbacks run at all.
test('closeProtocol tears the peer down while the socket is still alive', async (t) => {
  const a = await overlay(t, 'cp-a')
  const b = await overlay(t, 'cp-b')
  const [pa, pb] = makeDuplex()
  a.attachProtocol(Protomux.from(pa))
  b.attachProtocol(Protomux.from(pb))
  await settle()

  t.is(a.peerCount, 1, 'the channel opened')

  a.closeProtocol()
  await settle()

  t.is(b.peerCount, 0, 'the remote saw the channel close')
  t.absent(pa.destroyed, 'our socket stayed up')
  t.absent(pb.destroyed, 'and so did the remote one')
})
