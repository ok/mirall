import test from 'brittle'
import b4a from 'b4a'
import z32 from 'z32'
import crypto from 'hypercore-crypto'
import idEncoding from 'hypercore-id-encoding'
import { _encodeTicketForTests, parseRelayInput, TICKET_CHARS, TICKET_PREFIX } from '../../src/shared/transfer/relay-ticket.js'

// The frozen vector from the relay↔client contract §2.5, duplicated verbatim in
// mirall-relay. If this fails, one of the two repos has drifted and the invite format is
// broken — do not "fix" it by regenerating the expected string.
const RELAY_SEED = crypto.hash(b4a.from('mirall-relay demo relay seed'))
const MEMBER_SEED = crypto.hash(b4a.from('mirall-relay demo member seed'))
const RELAY_KEY = 'usdgj55ym13jkwz7nyrn4tf9yog5ocqhgbzpmiapfunqoj398xqo'
const MEMBER_KEY = 'mrgq43jtgdacci91sdt9fxogdzc7wxtcu71mqi45sgf6e61p3rxy'
const PAYLOAD = 'ygqac38xcbqmffk19weyomkrzhny5qbt5oag7iqzbwscj4b88h7758musqus5hrut9afmj5qjorsaigcrtpumig5gg4af6i4uzxjjm1qhz55ppy'

test('the pinned vector encodes exactly', (t) => {
  t.is(b4a.toString(RELAY_SEED, 'hex'), 'f50ded0ad862192ce2c8e2e977a471fa773352ae07c3ce9fe2ea28b648a16210')
  t.is(b4a.toString(MEMBER_SEED, 'hex'), '9d73b3a76df0938ff055a76e4c096c54cc245b35d4db31b582faba9dde94ae4e')
  t.is(idEncoding.encode(crypto.keyPair(RELAY_SEED).publicKey), RELAY_KEY)
  t.is(idEncoding.encode(crypto.keyPair(MEMBER_SEED).publicKey), MEMBER_KEY)

  const payload = _encodeTicketForTests(crypto.keyPair(RELAY_SEED).publicKey, MEMBER_SEED)
  t.is(payload.length, TICKET_CHARS)
  t.is(payload, PAYLOAD, 'the wire format is frozen — a mismatch here is a contract break')
})

test('a ticket parses to the relay key and the member seed', (t) => {
  for (const form of [PAYLOAD, TICKET_PREFIX + PAYLOAD, `  ${TICKET_PREFIX}${PAYLOAD}  `, PAYLOAD.toUpperCase(), `${TICKET_PREFIX}${PAYLOAD}/`]) {
    const res = parseRelayInput(form)
    t.is(res.ok, true, 'accepted')
    t.is(res.kind, 'private')
    t.is(res.publicKey, RELAY_KEY)
    t.ok(b4a.equals(res.seed, MEMBER_SEED))
  }
  // The member key the operator wrote to their roster, derived from what we parsed. The
  // whole membership model rests on these being the same 32 bytes on both sides.
  t.is(idEncoding.encode(crypto.keyPair(parseRelayInput(PAYLOAD).seed).publicKey), MEMBER_KEY)
})

test('a one-character truncation is rejected by length, not by the checksum', (t) => {
  const short = PAYLOAD.slice(0, 110)
  // The trap, asserted so nobody has to rediscover it: 111 z32 characters carry 555 bits
  // for 552 bits of payload, so the last character is pure slack. A one-character
  // truncation decodes to the SAME 69 bytes — version 1, checksum intact. Only the length
  // gate sees it. If the first assertion fails, z32 changed and the gate needs rethinking;
  // if the second fails, someone removed the gate.
  t.alike(z32.decode(short), z32.decode(PAYLOAD), 'the checksum cannot see this')
  t.is(z32.decode(short).byteLength, 69)
  t.alike(parseRelayInput(short), { ok: false, code: 'incomplete-invite' })
})

// The length gate catches the commonest clipboard failure, so the message behind it has to be
// the useful one. Telling someone who pasted 110 of 111 characters that this "is not a relay
// key or an invite" wastes the only chance we get to say "copy the whole thing".
test('a mangled invite is told to copy the whole thing, not that it is unrecognisable', (t) => {
  for (const input of [PAYLOAD.slice(0, 110), PAYLOAD + 'y', TICKET_PREFIX + PAYLOAD.slice(0, 110), TICKET_PREFIX + 'nope']) {
    t.is(parseRelayInput(input).code, 'incomplete-invite', input.slice(0, 24))
  }
  for (const input of ['not-a-relay-key', 'ws://relay.example.com:8080', '', 'hello world']) {
    t.is(parseRelayInput(input).code, 'invalid-format', `nothing like an invite: ${input.slice(0, 20)}`)
  }
  // A key-length z32 run is a key attempt, not a mangled invite.
  t.is(parseRelayInput(RELAY_KEY.slice(0, 51)).code, 'invalid-format')
})

test('three distinct errors, never one generic invalid', (t) => {
  t.is(parseRelayInput('hello').code, 'invalid-format')
  t.is(parseRelayInput('').code, 'invalid-format')
  t.is(parseRelayInput(null).code, 'invalid-format')
  t.is(parseRelayInput(PAYLOAD.slice(0, 110) + '!').code, 'invalid-format', 'a bad character')

  // Re-checksummed, so this is a WELL-FORMED v2 ticket: the version check must fire before
  // the checksum, or a future format reads as corruption.
  const future = z32.decode(PAYLOAD)
  future[0] = 2
  b4a.copy(crypto.hash(future.subarray(0, 65)).subarray(0, 4), future, 65)
  t.is(parseRelayInput(z32.encode(future)).code, 'unsupported-version')

  const altered = z32.decode(PAYLOAD)
  altered[40] ^= 0xff
  t.is(parseRelayInput(z32.encode(altered)).code, 'checksum-failed')
})

// REGRESSION (FIX-2: only the ends were trimmed, so a bare payload that had soft-wrapped in mail
// or chat failed the alphabet check and reported invalid-format — "that is not a relay key or an
// invite" — for the commonest way a 111-character string is delivered.)
test('REGRESSION (FIX-2: interior whitespace in a bare payload)', (t) => {
  for (const mangled of [
    PAYLOAD.slice(0, 72) + '\n' + PAYLOAD.slice(72),
    PAYLOAD.slice(0, 40) + ' ' + PAYLOAD.slice(40),
    PAYLOAD.slice(0, 55) + '\r\n  ' + PAYLOAD.slice(55),
  ]) {
    const res = parseRelayInput(mangled)
    t.is(res.ok, true, 'a wrapped paste is still the same ticket')
    t.is(res.publicKey, RELAY_KEY)
  }
  // And a wrapped paste that is ALSO short still reaches the useful message.
  t.is(parseRelayInput(PAYLOAD.slice(0, 72) + '\n' + PAYLOAD.slice(72, 110)).code, 'incomplete-invite')
})

test('lengths do not collide, so the paste field needs no mode switch', (t) => {
  t.is(parseRelayInput(RELAY_KEY).kind, 'open', '52 — z-base-32 key')
  t.is(parseRelayInput(RELAY_KEY).publicKey, RELAY_KEY)
  t.is(parseRelayInput(b4a.toString(b4a.alloc(32, 7), 'hex')).kind, 'open', '64 — hex key')
  t.is(parseRelayInput(`pear://${RELAY_KEY}`).kind, 'open', '59 — pear:// URL')
  t.is(parseRelayInput(`pear://${RELAY_KEY}`).publicKey, RELAY_KEY, 'normalized to canonical z32')
  t.is(parseRelayInput(PAYLOAD).kind, 'private', '111 — ticket payload')
  t.is(parseRelayInput(TICKET_PREFIX + PAYLOAD).kind, 'private', '126 — mirall://relay/')
})

test('an upper-case relay key stays rejected', (t) => {
  // Today's decoder refuses it and one test pins that; the ticket path lower-cases, the key
  // path deliberately does not.
  t.is(parseRelayInput(RELAY_KEY.toUpperCase()).ok, false)
})
