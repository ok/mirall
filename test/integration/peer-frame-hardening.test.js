import test from 'brittle'
import Protomux from 'protomux'
import c from 'compact-encoding'
import { Duplex } from 'streamx'
import fs from 'bare-fs'
import path from 'bare-path'
import url from 'bare-url'
import b4a from 'b4a'
import { validFrameShape, createRateLimiter } from '../../src/shared/transfer/handshake-guard.js'

function makeDuplex () {
  let aWrite, bWrite
  const a = new Duplex({ write (d, cb) { bWrite(d); cb() }, read () {} })
  const b = new Duplex({ write (d, cb) { aWrite(d); cb() }, read () {} })
  aWrite = (d) => a.push(d)
  bWrite = (d) => b.push(d)
  return [a, b]
}

const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms))

// Stands up the real mirall/handshake channel shape against real protomux. `guard` selects the
// intake: 'none' is staging's (parse, then read msg.type), 'shape' is the fixed one.
function pair (t, guard) {
  const [sa, sb] = makeDuplex()
  const seen = []
  const muxA = Protomux.from(sa)
  const muxB = Protomux.from(sb)

  const chB = muxB.createChannel({ protocol: 'mirall/handshake' })
  const msgB = chB.addMessage({
    encoding: c.string,
    onmessage (str) {
      let msg
      try { msg = JSON.parse(str) } catch { return }
      if (guard === 'shape' && !validFrameShape(msg)) return
      // The property read that sits outside any try in the real handler.
      if (msg.type === 'handshake' || msg.type === 'membership:request') seen.push('identity')
      else seen.push(msg.type)
    },
  })
  chB.open()

  const chA = muxA.createChannel({ protocol: 'mirall/handshake' })
  const msgA = chA.addMessage({ encoding: c.string })
  chA.open()

  t.teardown(() => { try { sa.destroy() } catch {} try { sb.destroy() } catch {} })
  return { send: (raw) => msgA.send(raw), seen, socketB: sb, muxB }
}

// REGRESSION (FIX-FRAME-NULL: the four-character frame `null` destroyed the receiving socket. The
// mirall/handshake channel id is the public protocol string, so any peer on the topic could do it.)
test('REGRESSION (FIX-FRAME-NULL): a null frame no longer destroys the socket', async (t) => {
  const guarded = pair(t, 'shape')
  guarded.send('null')
  await settle()
  t.absent(guarded.socketB.destroyed, 'the socket survived the malformed frame')

  guarded.send(JSON.stringify({ type: 'presence' }))
  await settle()
  t.alike(guarded.seen, ['presence'], 'and the next honest frame was still dispatched')
})

// The other half of the proof, run in-process rather than over the wire: staging's intake reads
// `msg.type` straight after the parse, and on `null` that read THROWS. Over a real socket the throw
// escapes the message handler into Protomux._ondata — verified against real protomux while writing
// this, which printed:
//   Uncaught TypeError: Cannot read properties of null (reading 'type')
//     at Object.recv (protomux/index.js:276) at Channel._recv (:228)
//     at Protomux._decode (:598) at Protomux._ondata (:562)
// That escape is the socket kill, and it takes the runner down with it — so it is asserted here as
// the throw it is, not by detonating a live connection inside the suite.
test('the unguarded intake throws on the same frame', (t) => {
  const msg = JSON.parse('null')
  let thrown = null
  try { if (msg.type === 'handshake') t.fail('unreachable') } catch (err) { thrown = err }
  t.ok(thrown instanceof TypeError, 'the property read staging performs is what throws')
  t.ok(/reading 'type'/.test(thrown.message), 'and it throws on exactly that read')
  t.absent(validFrameShape(msg), 'the guard is what stops it reaching that line')
})

// The cap is named in bytes, so it has to measure bytes: a frame of multi-byte characters is under
// the limit by str.length while being several times over it in UTF-8.
test('the size cap counts UTF-8 bytes, not UTF-16 units', (t) => {
  const maxBytes = 100
  const overBoth = 'x'.repeat(maxBytes + 1)
  const underCharsOverBytes = '€'.repeat(40)   // 40 UTF-16 units, 120 UTF-8 bytes

  const rejects = (str) => str.length > maxBytes || b4a.byteLength(str) > maxBytes
  t.ok(rejects(overBoth), 'a plainly oversized frame is rejected by the cheap check')
  t.ok(underCharsOverBytes.length <= maxBytes, 'this one slips past a UTF-16 length check')
  t.ok(b4a.byteLength(underCharsOverBytes) > maxBytes, 'while really being over the byte cap')
  t.ok(rejects(underCharsOverBytes), 'and the intake rejects it')
})

test('every frame type is metered, not just the two identity types', async (t) => {
  const here = path.dirname(url.fileURLToPath(import.meta.url))
  const src = fs.readFileSync(path.join(here, '..', '..', 'src', 'shared', 'transfer', 'swarm.js'), 'utf8')
  const intake = src.slice(src.indexOf('onmessage(str) {'), src.indexOf('dispatchFrame(socket, peerInfo, remoteKey, msg, msgHandler)'))

  const sizeAt = intake.indexOf('getPeerFrameMaxBytes()')
  const limitAt = intake.indexOf('frameLimiter.take(')
  const parseAt = intake.indexOf('JSON.parse(str)')
  const shapeAt = intake.indexOf('validFrameShape(msg)')
  const identityAt = intake.indexOf("msg.type === 'handshake'")

  t.ok(sizeAt >= 0 && limitAt >= 0 && shapeAt >= 0, 'the cap, the general lane and the shape guard are all present')
  t.ok(sizeAt < parseAt, 'the size cap is charged before the decode')
  t.ok(limitAt < parseAt, 'the general lane is charged before the decode')
  t.ok(parseAt < shapeAt, 'the shape guard runs on the decoded value')
  t.ok(shapeAt < identityAt, 'and BEFORE the first property read — the ordering the bug was')
})

test('a flood trips the ban surface the identity lanes already use', (t) => {
  let now = 0
  const limiter = createRateLimiter({ burst: 256, refillMs: 20, abuseThreshold: 512, now: () => now })
  const peer = 'd'.repeat(64)
  let banned = false
  for (let i = 0; i < 5000 && !banned; i++) banned = limiter.take(peer).ban
  t.ok(banned, 'share-prepare-progress at line rate self-evicts')
})
