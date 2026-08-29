import test from 'brittle'
import Protomux from 'protomux'
import { Duplex } from 'streamx'
import * as messages from '../../src/shared/transfer/backends/overlay/vendor/messages-v2.js'

// The overlay channel's handshake carries {version, capabilities}. protomux only puts a
// handshake on the wire when the channel DECLARES an encoding — today's code passes the object
// to channel.open() without declaring one, so the bits were silently dropped and _onOpen saw
// nothing. Declaring the encoding is the fix; the risk is the field: v1.8.0 and v1.9.0 peers send
// an open frame with NO handshake bytes, and protomux hands that empty tail straight to the
// decoder, destroying the whole mux (every channel on the socket) on a throw. This matrix is the
// proof that the tolerant decoder handles all four pairings.

function pair () {
  let aPush, bPush
  const a = new Duplex({ write (d, cb) { bPush(d); cb() }, read () {} })
  const b = new Duplex({ write (d, cb) { aPush(d); cb() }, read () {} })
  aPush = (d) => a.push(d)
  bPush = (d) => b.push(d)
  return [a, b]
}
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms))

// "new" declares the encoding and sends the bits; "old" is exactly today's shape — no handshake
// encoding, an open() argument that goes nowhere. A sibling channel on the same mux stands in for
// mirall/handshake: if a decode throw destroys the mux, the sibling dies with it.
function open (stream, kind, seen) {
  const mux = Protomux.from(stream)
  const sibling = mux.createChannel({ protocol: 'mirall/handshake' })
  sibling.open()
  const channel = mux.createChannel({
    protocol: 'hyper-overlay/v2',
    ...(kind === 'new' ? { handshake: messages.handshake } : {}),
    onopen (hs) { seen.push(hs === undefined ? 'undefined' : hs) },
  })
  channel.open({ version: 2, capabilities: 0x03 })
  return { mux, channel, sibling }
}

async function matrix (t, left, right) {
  const [sa, sb] = pair()
  const seenL = []
  const seenR = []
  const L = open(sa, left, seenL)
  const R = open(sb, right, seenR)
  await settle()
  t.absent(sa.destroyed, `${left} to ${right}: the socket survives`)
  t.absent(sb.destroyed, `${right} to ${left}: the socket survives`)
  t.absent(L.sibling.closed, 'the sibling control channel survives')
  t.absent(R.sibling.closed, 'the sibling control channel survives')
  return { seenL, seenR }
}

test('new to new: both sides read the announced version and capabilities', async (t) => {
  const { seenL, seenR } = await matrix(t, 'new', 'new')
  t.is(seenL[0]?.version, 2, 'left saw the remote version')
  t.is(seenL[0]?.capabilities, 0x03, 'and its capability bits')
  t.is(seenR[0]?.version, 2)
  t.is(seenR[0]?.capabilities, 0x03)
})

// REGRESSION (FIX-OVERLAY-HANDSHAKE: declaring the strict encoding as it stood destroyed the
// whole mux against a peer that sends no handshake bytes — every v1.8.0 and v1.9.0 build in the
// field. The tolerant decoder reads an empty tail as the unannounced default instead.)
test('REGRESSION (FIX-OVERLAY-HANDSHAKE): new to old — the old peer is read as unannounced, nothing is destroyed', async (t) => {
  const { seenL } = await matrix(t, 'new', 'old')
  t.is(seenL[0]?.version, messages.UNANNOUNCED_HANDSHAKE.version, 'an old peer reads as the unannounced version')
  t.is(seenL[0]?.capabilities, 0, 'with no capability bits, so a cap-gated behaviour stays off')
})

test('old to new: the old peer ignores the extra bytes and stays up', async (t) => {
  const { seenR } = await matrix(t, 'old', 'new')
  t.is(seenR[0]?.version, messages.UNANNOUNCED_HANDSHAKE.version, 'the new side still reads the old peer as unannounced')
})

test('old to old: unchanged — the pairing every installed build uses today', async (t) => {
  await matrix(t, 'old', 'old')
  t.pass('no handshake either way, no destruction')
})

// The decoder is TOTAL: it must not throw on any tail. An absent one is an old build; a
// truncated one is garbage or a hostile peer. Both read as the unannounced default.
test('the decoder never throws, whatever the tail', (t) => {
  t.alike(messages.handshake.decode({ start: 0, end: 0, buffer: Buffer.alloc(0) }),
    { version: 1, capabilities: 0 }, 'an empty tail reads as unannounced')
  t.alike(messages.handshake.decode({ start: 0, end: 1, buffer: Buffer.from([2]) }),
    { version: 2, capabilities: 0 }, 'a one-byte tail reads its version, no caps')
  t.alike(messages.handshake.decode({ start: 0, end: 3, buffer: Buffer.from([2, 3, 9]) }),
    { version: 2, capabilities: 3 }, 'a longer tail is forward-tolerant: extra bytes are ignored')
})

// A handshake encoding that puts exactly one byte on the wire — what a hostile or future peer
// sends. The channel id is the public protocol string (overlay-v2 passes no key), so ANY swarm
// peer can open this channel; a decoder that threw here would hand it a one-frame kill of the
// whole Noise socket — mirall/handshake and corestore replication with it.
const oneByteHandshake = {
  preencode (state) { state.end += 1 },
  encode (state) { state.buffer[state.start++] = 7 },
  decode (state) { state.start = state.end; return null },
}

// REGRESSION (FIX-OVERLAY-HANDSHAKE: with a strict decoder this frame destroys the victim's mux.)
test('REGRESSION (FIX-OVERLAY-HANDSHAKE): a malformed tail does not destroy the socket', async (t) => {
  const [sa, sb] = pair()
  const seen = []
  const victim = open(sa, 'new', seen)
  const attacker = Protomux.from(sb)
  // The sibling exists on both muxes for the same reason as in the matrix: protomux rejects a
  // session for a protocol it has no channel for, and that rejection would close the victim's
  // sibling for a reason unrelated to the handshake under test.
  attacker.createChannel({ protocol: 'mirall/handshake' }).open()
  attacker.createChannel({ protocol: 'hyper-overlay/v2', handshake: oneByteHandshake }).open(null)
  await settle()
  t.absent(sa.destroyed, 'the victim socket survives a one-byte handshake')
  t.absent(victim.sibling.closed, 'and its sibling control channel is untouched')
  t.is(seen[0]?.version, 7, 'the byte it did send is read')
  t.is(seen[0]?.capabilities, 0, 'and the absent one falls back')
})

// Wire-byte pin: a new peer's open frame is the old one plus exactly two bytes.
test('the announced handshake is two bytes on the wire', (t) => {
  const state = { start: 0, end: 0, buffer: null }
  messages.handshake.preencode(state, { version: 2, capabilities: 0x03 })
  t.is(state.end, 2, 'version + capabilities, one byte each')
  state.buffer = Buffer.alloc(state.end)
  messages.handshake.encode(state, { version: 2, capabilities: 0x03 })
  t.alike([...state.buffer], [2, 3], 'exact bytes')
})
