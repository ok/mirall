import test from 'brittle'
import Protomux from 'protomux'
import { Duplex } from 'streamx'
import { tmpStore, tmpDir } from './overlay-vendor-helpers.js'
import { HyperOverlayV2 } from '../../src/shared/transfer/backends/overlay/vendor/overlay-v2.js'
import { VERSION, MIN_VERSION, CAP_LOCAL_FILES, CAP_ADAPTIVE_CHUNKS } from '../../src/shared/transfer/backends/overlay/vendor/protocol-v2.js'

function makeDuplex () {
  let aWrite, bWrite
  const a = new Duplex({ write (d, cb) { bWrite(d); cb() }, read () {} })
  const b = new Duplex({ write (d, cb) { aWrite(d); cb() }, read () {} })
  aWrite = (d) => a.push(d)
  bWrite = (d) => b.push(d)
  return [a, b]
}
const settle = (ms = 500) => new Promise((r) => setTimeout(r, ms))

async function overlay (t, label, opts = {}) {
  const o = new HyperOverlayV2(tmpStore(label), { namespace: 'mirall-overlay', destDir: tmpDir(label + '-d'), ...opts })
  await o.ready()
  t.teardown(async () => { try { await o.close() } catch {} })
  return o
}

// REGRESSION (FIX-OVERLAY-HANDSHAKE: channel.open() was handed { version, capabilities } but the
// channel declared no handshake encoding, so protomux never put the bits on the wire and _onOpen
// never saw them — the content channel had no negotiated version at all.)
test('REGRESSION (FIX-OVERLAY-HANDSHAKE): both peers learn the remote overlay version and caps', async (t) => {
  const opened = []
  const a = await overlay(t, 'hs-a', { onPeerOpen: (info) => opened.push(info) })
  const b = await overlay(t, 'hs-b')
  const [pa, pb] = makeDuplex()
  a.attachProtocol(Protomux.from(pa))
  b.attachProtocol(Protomux.from(pb))
  await settle()

  const peer = [...a._protocol._peers.values()][0]
  t.ok(peer, 'the channel opened')
  t.is(peer.remoteVersion, VERSION, 'the remote version reached us')
  t.is(peer.remoteCaps, CAP_LOCAL_FILES | CAP_ADAPTIVE_CHUNKS, 'and its capability bits')
  t.is(opened.length, 1, 'the instance layer was told once')
  t.is(opened[0].version, VERSION)
})

// The gate closes the CONTENT channel only — never the socket, which also carries
// mirall/handshake and corestore replication.
test('a peer below the minimum loses its content channel, not its socket', async (t) => {
  const rejected = []
  const a = await overlay(t, 'hs-gate-a', { minVersion: VERSION + 1, onPeerRejected: (info) => rejected.push(info) })
  const b = await overlay(t, 'hs-gate-b')
  const [pa, pb] = makeDuplex()
  a.attachProtocol(Protomux.from(pa))
  b.attachProtocol(Protomux.from(pb))
  await settle()

  t.is(rejected.length, 1, 'the rejection was reported')
  t.is(rejected[0].version, VERSION, 'naming the version we refused')
  t.is(rejected[0].minVersion, VERSION + 1)
  t.absent(pa.destroyed, 'the socket stays up')
  t.absent(pb.destroyed, 'on both sides')
  // The gate must not leak the peer it refused: protomux runs onclose synchronously inside
  // close(), and the vendored onclose is what drops the entry.
  t.is(a._protocol.peerCount, 0, 'the rejected peer is not retained')
})

test('the shipped minimum refuses nothing in the field', (t) => {
  t.is(MIN_VERSION, 1, 'the minimum is the unannounced version, so no installed build is gated out')
  t.ok(VERSION > MIN_VERSION, 'and the current version is above it')
})
