import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { decodeInvite, encodeInvite, extractInviteCode, NAME_MAX } from '../../src/shared/invite-envelope.js'
import * as contract from '../../src/shared/contract/invite-envelope.js'

const HEX = 'a'.repeat(64)
const HEX_DASHED = 'aaaaaaaa-aaaaaaaa-aaaaaaaa-aaaaaaaa-aaaaaaaa-aaaaaaaa-aaaaaaaa-aaaaaaaa'

test('legacy bare hex decodes to v0', (t) => {
  const out = decodeInvite(HEX)
  t.alike(out, { v: 0, topic: HEX })
})

test('legacy dashed hex decodes to v0', (t) => {
  const out = decodeInvite(HEX_DASHED)
  t.alike(out, { v: 0, topic: HEX })
})

test('legacy uppercase hex normalises to lowercase', (t) => {
  const out = decodeInvite('A'.repeat(64))
  t.alike(out, { v: 0, topic: 'a'.repeat(64) })
})

test('legacy hex tolerates surrounding whitespace', (t) => {
  t.alike(decodeInvite('  ' + HEX + '\n'), { v: 0, topic: HEX })
})

test('encode produces base64url shape', (t) => {
  const enc = encodeInvite({ topic: HEX, name: 'Acme' })
  t.is(typeof enc, 'string')
  t.ok(/^[A-Za-z0-9_-]+$/.test(enc))
  t.absent(enc.includes('='))
  t.absent(enc.includes('+'))
  t.absent(enc.includes('/'))
})

test('encode/decode round-trip preserves topic and name', (t) => {
  const enc = encodeInvite({ topic: HEX, name: 'Acme Project' })
  t.alike(decodeInvite(enc), { v: 1, topic: HEX, name: 'Acme Project' })
})

test('encode without name omits the name field', (t) => {
  const enc = encodeInvite({ topic: HEX })
  const dec = decodeInvite(enc)
  t.is(dec.v, 1)
  t.is(dec.topic, HEX)
  t.is(dec.name, undefined)
})

test('encode with empty name omits the name field', (t) => {
  const enc = encodeInvite({ topic: HEX, name: '' })
  t.is(decodeInvite(enc).name, undefined)
})

test('encode truncates name beyond NAME_MAX', (t) => {
  const long = 'x'.repeat(NAME_MAX + 50)
  const enc = encodeInvite({ topic: HEX, name: long })
  const dec = decodeInvite(enc)
  t.is(dec.name.length, NAME_MAX)
})

test('decode truncates name beyond NAME_MAX from the wire', (t) => {
  const long = 'x'.repeat(NAME_MAX + 50)
  const obj = { v: 1, t: HEX, n: long }
  const json = JSON.stringify(obj)
  const enc = Buffer.from(json, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const dec = decodeInvite(enc)
  t.is(dec.name.length, NAME_MAX)
})

test('encode preserves UTF-8 names', (t) => {
  const enc = encodeInvite({ topic: HEX, name: 'Müller — café 日本' })
  t.is(decodeInvite(enc).name, 'Müller — café 日本')
})

test('encode normalises uppercase topic to lowercase', (t) => {
  const enc = encodeInvite({ topic: 'B'.repeat(64), name: 'X' })
  t.is(decodeInvite(enc).topic, 'b'.repeat(64))
})

test('encode rejects non-hex topic', (t) => {
  t.exception(() => encodeInvite({ topic: 'not-hex' }))
})

test('encode rejects topic of wrong length', (t) => {
  t.exception(() => encodeInvite({ topic: 'a'.repeat(63) }))
  t.exception(() => encodeInvite({ topic: 'a'.repeat(65) }))
})

test('decode null on non-string input', (t) => {
  t.is(decodeInvite(null), null)
  t.is(decodeInvite(undefined), null)
  t.is(decodeInvite(42), null)
  t.is(decodeInvite({}), null)
})

test('decode null on empty input', (t) => {
  t.is(decodeInvite(''), null)
  t.is(decodeInvite('   '), null)
})

test('decode null on malformed base64', (t) => {
  t.is(decodeInvite('not base64!!!'), null)
})

test('decode null on valid base64 but invalid JSON', (t) => {
  const enc = Buffer.from('not json', 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  t.is(decodeInvite(enc), null)
})

test('decode null on JSON missing topic', (t) => {
  const enc = Buffer.from(JSON.stringify({ v: 1 }), 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  t.is(decodeInvite(enc), null)
})

test('decode null on JSON with non-hex topic', (t) => {
  const enc = Buffer.from(JSON.stringify({ v: 1, t: 'zzz' }), 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  t.is(decodeInvite(enc), null)
})

test('decode null on unknown version', (t) => {
  const enc = Buffer.from(JSON.stringify({ v: 2, t: HEX }), 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  t.is(decodeInvite(enc), null)
})

test('decode null on JSON array', (t) => {
  const enc = Buffer.from(JSON.stringify([HEX]), 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  t.is(decodeInvite(enc), null)
})

test('decode null on JSON null', (t) => {
  const enc = Buffer.from('null', 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  t.is(decodeInvite(enc), null)
})

const OWNER = 'b'.repeat(64)

test('round-trip preserves inviter owner key and name', (t) => {
  const enc = encodeInvite({ topic: HEX, name: 'Acme', owner: OWNER, ownerName: 'Alice' })
  t.alike(decodeInvite(enc), { v: 1, topic: HEX, name: 'Acme', owner: OWNER, ownerName: 'Alice' })
})

test('owner key is normalised to lowercase', (t) => {
  const enc = encodeInvite({ topic: HEX, owner: 'B'.repeat(64), ownerName: 'Alice' })
  t.is(decodeInvite(enc).owner, OWNER)
})

test('owner without an owner name omits the name', (t) => {
  const dec = decodeInvite(encodeInvite({ topic: HEX, owner: OWNER }))
  t.is(dec.owner, OWNER)
  t.is(dec.ownerName, undefined)
})

test('encode drops a non-hex owner (and its name)', (t) => {
  const dec = decodeInvite(encodeInvite({ topic: HEX, owner: 'not-hex', ownerName: 'Alice' }))
  t.is(dec.owner, undefined)
  t.is(dec.ownerName, undefined)
})

test('encode without an owner omits owner fields (backward compatible)', (t) => {
  const dec = decodeInvite(encodeInvite({ topic: HEX, name: 'Acme' }))
  t.is(dec.owner, undefined)
  t.is(dec.ownerName, undefined)
})

test('decode ignores an owner name with no owner key on the wire', (t) => {
  const enc = Buffer.from(JSON.stringify({ v: 1, t: HEX, d: 'Alice' }), 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const dec = decodeInvite(enc)
  t.is(dec.owner, undefined)
  t.is(dec.ownerName, undefined)
})

test('decode drops a non-hex owner key from the wire', (t) => {
  const enc = Buffer.from(JSON.stringify({ v: 1, t: HEX, o: 'zzz', d: 'Alice' }), 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const dec = decodeInvite(enc)
  t.is(dec.owner, undefined)
  t.is(dec.ownerName, undefined)
})

test('encode truncates owner name beyond NAME_MAX', (t) => {
  const dec = decodeInvite(encodeInvite({ topic: HEX, owner: OWNER, ownerName: 'x'.repeat(NAME_MAX + 50) }))
  t.is(dec.ownerName.length, NAME_MAX)
})

test('decode treats numeric name as missing', (t) => {
  const enc = Buffer.from(JSON.stringify({ v: 1, t: HEX, n: 42 }), 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const dec = decodeInvite(enc)
  t.is(dec.v, 1)
  t.is(dec.name, undefined)
})

const CREATOR = 'c'.repeat(64)

test('round-trip preserves the creator (OR-Set root) key', (t) => {
  const enc = encodeInvite({ topic: HEX, name: 'Acme', creator: CREATOR })
  t.is(decodeInvite(enc).creator, CREATOR)
})

test('creator key is normalised to lowercase', (t) => {
  t.is(decodeInvite(encodeInvite({ topic: HEX, creator: 'C'.repeat(64) })).creator, CREATOR)
})

test('creator and owner are independent fields', (t) => {
  // The whole point of the field: the inviter (owner) is not necessarily the creator.
  const dec = decodeInvite(encodeInvite({ topic: HEX, owner: OWNER, ownerName: 'Bob', creator: CREATOR }))
  t.is(dec.owner, OWNER)
  t.is(dec.creator, CREATOR)
})

test('encode drops a non-hex creator', (t) => {
  t.is(decodeInvite(encodeInvite({ topic: HEX, creator: 'not-hex' })).creator, undefined)
})

test('encode without a creator omits it (backward compatible)', (t) => {
  t.is(decodeInvite(encodeInvite({ topic: HEX, name: 'Acme' })).creator, undefined)
})

test('decode drops a non-hex creator key from the wire', (t) => {
  const enc = Buffer.from(JSON.stringify({ v: 1, t: HEX, c: 'zzz' }), 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  t.is(decodeInvite(enc).creator, undefined)
})

test('schemaVersion round-trips and stays absent for v1', (t) => {
  t.is(decodeInvite(encodeInvite({ topic: HEX, schemaVersion: 2 })).schemaVersion, 2)
  t.is(decodeInvite(encodeInvite({ topic: HEX })).schemaVersion, undefined)
})

test('auto-admit flag + inviteId round-trip; default off', (t) => {
  const id = 'ab'.repeat(16)
  const dec = decodeInvite(encodeInvite({ topic: HEX, schemaVersion: 2, autoAdmit: true, inviteId: id }))
  t.is(dec.autoAdmit, true)
  t.is(dec.inviteId, id)
  t.absent(decodeInvite(encodeInvite({ topic: HEX, schemaVersion: 2 })).autoAdmit)
})

test('decode drops a malformed inviteId', (t) => {
  const dec = decodeInvite(encodeInvite({ topic: HEX, inviteId: 'nothex' }))
  t.is(dec.inviteId, undefined)
})

test('expiresAt round-trips and stays absent when unset', (t) => {
  const exp = 1893456000000
  t.is(decodeInvite(encodeInvite({ topic: HEX, schemaVersion: 2, expiresAt: exp })).expiresAt, exp)
  t.is(decodeInvite(encodeInvite({ topic: HEX, schemaVersion: 2 })).expiresAt, undefined)
})

test('encode drops a non-positive or non-integer expiresAt', (t) => {
  t.is(decodeInvite(encodeInvite({ topic: HEX, expiresAt: 0 })).expiresAt, undefined)
  t.is(decodeInvite(encodeInvite({ topic: HEX, expiresAt: -5 })).expiresAt, undefined)
  t.is(decodeInvite(encodeInvite({ topic: HEX, expiresAt: 1.5 })).expiresAt, undefined)
})

test('decode drops a non-positive or non-integer expiresAt from the wire', (t) => {
  for (const x of [0, -5, 1.5, 'soon']) {
    const enc = Buffer.from(JSON.stringify({ v: 1, t: HEX, x }), 'utf8').toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    t.is(decodeInvite(enc).expiresAt, undefined)
  }
})

// --- extractInviteCode: peel a pasted mirall://join App link to the bare code ---

test('extractInviteCode peels a path-form link to the envelope', (t) => {
  const env = encodeInvite({ topic: HEX, name: 'Acme' })
  t.is(extractInviteCode(`mirall://join/${env}`), env)
})

test('extractInviteCode peels the query-form link', (t) => {
  const env = encodeInvite({ topic: HEX })
  t.is(extractInviteCode(`mirall://join?code=${env}`), env)
})

test('extractInviteCode keeps dashed v0 hex carried in a link', (t) => {
  t.is(extractInviteCode(`mirall://join/${HEX_DASHED}`), HEX_DASHED)
})

test('extractInviteCode decodes a percent-encoded code in a link', (t) => {
  const env = encodeInvite({ topic: HEX, name: 'Acme' })
  t.is(extractInviteCode(`mirall://join/${encodeURIComponent(env)}`), env)
})

test('extractInviteCode trims whitespace around a link', (t) => {
  const env = encodeInvite({ topic: HEX })
  t.is(extractInviteCode(`  mirall://join/${env}\n`), env)
})

// REGRESSION (FIX-DEEPLINK-ARGV-1: pasting an invite link that came back from a
// browser or chat client with a trailing slash failed while the bare code worked).
test('REGRESSION (FIX-DEEPLINK-ARGV-1): extractInviteCode strips a trailing slash', (t) => {
  const env = encodeInvite({ topic: HEX, name: 'Acme' })
  t.is(extractInviteCode(`mirall://join/${env}/`), env)
  t.is(extractInviteCode(`mirall://join/${HEX_DASHED}/`), HEX_DASHED)
  t.alike(decodeInvite(`mirall://join/${env}/`), { v: 1, topic: HEX, name: 'Acme' })
})

test('extractInviteCode passes a bare code through unchanged', (t) => {
  t.is(extractInviteCode(HEX), HEX)
  t.is(extractInviteCode(HEX_DASHED), HEX_DASHED)
  const env = encodeInvite({ topic: HEX })
  t.is(extractInviteCode(env), env)
})

test('extractInviteCode leaves a non-mirall URL untouched', (t) => {
  t.is(extractInviteCode('https://example.com/x'), 'https://example.com/x')
})

test('extractInviteCode leaves a wrong-verb mirall link untouched', (t) => {
  t.is(extractInviteCode(`mirall://space/${HEX}`), `mirall://space/${HEX}`)
})

test('extractInviteCode returns empty for a join link carrying no code', (t) => {
  t.is(extractInviteCode('mirall://join/'), '')
  t.is(extractInviteCode('mirall://join'), '')
})

test('extractInviteCode returns empty on non-string / empty input', (t) => {
  t.is(extractInviteCode(null), '')
  t.is(extractInviteCode(undefined), '')
  t.is(extractInviteCode(42), '')
  t.is(extractInviteCode(''), '')
  t.is(extractInviteCode('   '), '')
})

// --- decodeInvite is link-tolerant (the worker space:join seam, defence in depth) ---

test('decodeInvite accepts a mirall://join link wrapping a v0 hex code', (t) => {
  t.alike(decodeInvite(`mirall://join/${HEX}`), { v: 0, topic: HEX })
  t.alike(decodeInvite(`mirall://join/${HEX_DASHED}`), { v: 0, topic: HEX })
})

test('decodeInvite accepts a mirall://join link wrapping a v1 envelope', (t) => {
  const enc = encodeInvite({ topic: HEX, name: 'Acme' })
  t.alike(decodeInvite(`mirall://join/${enc}`), { v: 1, topic: HEX, name: 'Acme' })
})

test('decodeInvite accepts the query form of the link', (t) => {
  const enc = encodeInvite({ topic: HEX })
  t.is(decodeInvite(`mirall://join?code=${enc}`).topic, HEX)
})

test('decodeInvite returns null for a join link carrying no code', (t) => {
  t.is(decodeInvite('mirall://join/'), null)
})

test('REGRESSION (MIR-01): invite carries no content key / secret', (t) => {
  const ALLOWED = ['a', 'c', 'd', 'id', 'n', 'o', 's', 't', 'v', 'x']
  const cases = [
    { topic: HEX, name: 'Acme', owner: OWNER, ownerName: 'Alice', creator: CREATOR, schemaVersion: 2 },
    { topic: HEX, schemaVersion: 2, autoAdmit: true, inviteId: 'cd'.repeat(16), expiresAt: 1893456000000 },
  ]
  for (const opts of cases) {
    const decoded = JSON.parse(Buffer.from(encodeInvite(opts).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString())
    t.ok(Object.keys(decoded).every((k) => ALLOWED.includes(k)), 'only known non-secret fields')
    t.absent('sck' in decoded || 'k' in decoded || 'key' in decoded, 'no key field')
  }
})

// --- one decoder, reachable from every runtime ---

const here = path.dirname(fileURLToPath(import.meta.url))
const readSrc = (rel) => readFileSync(path.join(here, '..', '..', 'src', rel), 'utf8')

// REGRESSION (FIX-PI2-1: the renderer carried its own decoder whose DecodedInvite union had no
// field for the creator key, schema version, auto-admit flag or invite id, so a v2 invite decoded
// there came back v1-shaped with those four facts silently dropped. Both renderer call sites only
// displayed the name and expiry, so nothing broke visibly — the next feature to read one of the
// four would have found undefined and blamed the worker.)
test('REGRESSION (FIX-PI2-1): the renderer decoder returns every v2 field', (t) => {
  const id = 'ab'.repeat(16)
  const code = encodeInvite({ topic: HEX, name: 'Acme', creator: CREATOR, schemaVersion: 2, autoAdmit: true, inviteId: id })

  // The renderer is TypeScript, so the runner cannot import it — but it is a re-export of the
  // module tested here, which the structural assertions below pin.
  const decoded = contract.decodeInvite(code)
  t.is(decoded.creator, CREATOR)
  t.is(decoded.schemaVersion, 2)
  t.is(decoded.autoAdmit, true)
  t.is(decoded.inviteId, id)

  const renderer = readSrc('renderer/invite-envelope.ts')
  t.ok(/export \{[^}]*decodeInvite[^}]*\} from '\.\.\/shared\/contract\/invite-envelope\.js'/.test(renderer),
    'the renderer decodeInvite is the contract decodeInvite')
  t.absent(/function decodeInvite/.test(renderer), 'the renderer declares no decoder of its own')
})

test('the data layer re-exports the decoder rather than wrapping it', (t) => {
  t.is(decodeInvite, contract.decodeInvite, 'same function object, so behaviour cannot diverge')
  t.is(encodeInvite, contract.encodeInvite)
  t.is(extractInviteCode, contract.extractInviteCode)
  t.is(NAME_MAX, contract.NAME_MAX)
})

// The codec had to lose its b4a dependency to become reachable from the renderer, and Bare has no
// TextEncoder/TextDecoder to replace it with. These pin the replacement against the cases where a
// hand-rolled UTF-8 layer is easy to get wrong.
test('the codec round-trips text no matter which runtime encoded it', (t) => {
  for (const name of ['Acme', 'Grüße', '共有スペース', 'Space 😀🎉', '𝕄irall', 'a"b\\c/d', 'Müller — café 日本']) {
    t.is(decodeInvite(encodeInvite({ topic: HEX, name })).name, name, name)
  }
})

test('a name truncated mid-emoji still produces a decodable code', (t) => {
  // slice(0, NAME_MAX) can cut a surrogate pair in half; the encoder must not emit invalid UTF-8.
  const code = encodeInvite({ topic: HEX, name: 'x'.repeat(NAME_MAX - 1) + '😀' })
  const decoded = decodeInvite(code)
  t.is(decoded.topic, HEX)
  t.is(decoded.name.length, NAME_MAX)
})

test('the codec uses no runtime-specific text primitives', (t) => {
  // Comments stripped: the header names these primitives to explain why they are unusable here.
  const code = readSrc('shared/contract/invite-envelope.js').replace(/^\s*\/\/.*$/gm, '')
  t.absent(/TextEncoder|TextDecoder/.test(code), 'no TextEncoder — Bare does not have one')
  t.absent(/\bb4a\b|\bBuffer\b/.test(code), 'no b4a or Buffer — the renderer does not have those')
  t.ok(/\batob\(/.test(code) && /\bbtoa\(/.test(code), 'btoa/atob, which all three runtimes have')
})
