import test from 'brittle'
import { encodeInvite } from '../../src/shared/invite-envelope.js'

const { parseDeepLink } = await import('../../src/main/deeplink.js').then(m => m.default ?? m)

const HEX = 'a'.repeat(64)
const HEX_DASHED = 'aaaaaaaa-aaaaaaaa-aaaaaaaa-aaaaaaaa-aaaaaaaa-aaaaaaaa-aaaaaaaa-aaaaaaaa'
const ENV = encodeInvite({ topic: HEX, name: 'Acme' })

test('parses dashed hex from path', async (t) => {
  const out = await parseDeepLink(`mirall://join/${HEX_DASHED}`)
  t.alike(out, { kind: 'join', code: HEX_DASHED })
})

test('parses bare hex from path', async (t) => {
  const out = await parseDeepLink(`mirall://join/${HEX}`)
  t.alike(out, { kind: 'join', code: HEX })
})

test('parses uppercase hex', async (t) => {
  const out = await parseDeepLink(`mirall://join/${HEX.toUpperCase()}`)
  t.alike(out, { kind: 'join', code: HEX.toUpperCase() })
})

test('parses envelope with name', async (t) => {
  const out = await parseDeepLink(`mirall://join/${ENV}`)
  t.alike(out, { kind: 'join', code: ENV, name: 'Acme' })
})

test('parses envelope from query parameter', async (t) => {
  const out = await parseDeepLink(`mirall://join?code=${ENV}`)
  t.alike(out, { kind: 'join', code: ENV, name: 'Acme' })
})

test('omits name when envelope has no name', async (t) => {
  const env = encodeInvite({ topic: HEX })
  const out = await parseDeepLink(`mirall://join/${env}`)
  t.alike(out, { kind: 'join', code: env })
})

// REGRESSION (FIX-DEEPLINK-ARGV-1: a link that round-tripped through a browser or
// chat client can arrive with a trailing slash). Neither hex nor base64url contains
// '/', so the code is recovered rather than rejected as malformed.
test('REGRESSION (FIX-DEEPLINK-ARGV-1): tolerates a trailing slash on the path form', async (t) => {
  t.alike(await parseDeepLink(`mirall://join/${ENV}/`), { kind: 'join', code: ENV, name: 'Acme' })
  t.alike(await parseDeepLink(`mirall://join/${HEX}/`), { kind: 'join', code: HEX })
})

test('returns null on wrong scheme', async (t) => {
  t.is(await parseDeepLink(`https://join/${HEX}`), null)
  t.is(await parseDeepLink(`mirall2://join/${HEX}`), null)
})

test('returns null on wrong path verb', async (t) => {
  t.is(await parseDeepLink(`mirall://space/${HEX}`), null)
  t.is(await parseDeepLink(`mirall://${HEX}`), null)
})

test('returns null on missing code', async (t) => {
  t.is(await parseDeepLink('mirall://join'), null)
  t.is(await parseDeepLink('mirall://join/'), null)
  t.is(await parseDeepLink('mirall://join?code='), null)
})

test('returns null on malformed code', async (t) => {
  t.is(await parseDeepLink('mirall://join/not-an-invite'), null)
  t.is(await parseDeepLink('mirall://join/zzz'), null)
})

test('returns null on non-string input', async (t) => {
  t.is(await parseDeepLink(null), null)
  t.is(await parseDeepLink(undefined), null)
  t.is(await parseDeepLink(42), null)
  t.is(await parseDeepLink({}), null)
})

test('returns null on unparseable URL', async (t) => {
  t.is(await parseDeepLink('not a url at all'), null)
  t.is(await parseDeepLink(''), null)
})

test('handles percent-encoded path code', async (t) => {
  const encoded = encodeURIComponent(ENV)
  const out = await parseDeepLink(`mirall://join/${encoded}`)
  t.alike(out, { kind: 'join', code: ENV, name: 'Acme' })
})
