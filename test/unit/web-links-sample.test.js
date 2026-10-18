import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import b4a from 'b4a'
import { encodeInvite } from '../../src/shared/contract/invite-envelope.js'
import { _encodeTicketForTests } from '../../src/shared/network/relay-ticket.js'
import activationVectors from '../fixtures/managed/activation-link-v1.json' with { type: 'json' }

// The self-hosted sample page (docs/web-links/index.html) carries its own payload checks. They
// are run here against the app's vectors, so a grammar change in the app fails the sample too.
const here = path.dirname(fileURLToPath(import.meta.url))
const page = readFileSync(path.join(here, '..', '..', 'docs', 'web-links', 'index.html'), 'utf8')

function checks() {
  const start = page.indexOf('/* payload-checks:start */')
  const end = page.indexOf('/* payload-checks:end */')
  if (start < 0 || end < 0) throw new Error('payload-checks block missing from the sample page')
  return new Function(page.slice(start, end) + '; return KINDS')()
}

const HEX = 'a'.repeat(64)
const HEX_DASHED = 'aaaaaaaa-aaaaaaaa-aaaaaaaa-aaaaaaaa-aaaaaaaa-aaaaaaaa-aaaaaaaa-aaaaaaaa'
const TICKET = _encodeTicketForTests(b4a.alloc(32, 1), b4a.alloc(32, 2))
const ACTIVATION = `a/${activationVectors.valid[0].code}`

test('the sample maps every kind onto the app host the app routes', (t) => {
  const kinds = checks()
  t.alike(Object.keys(kinds).sort(), ['license', 'relay', 'space'])
  t.is(kinds.space.appHost, 'join')
  t.is(kinds.relay.appHost, 'relay')
  t.is(kinds.license.appHost, 'license')
})

test('the space check accepts what the app mints and rejects the rest', (t) => {
  const { space } = checks()
  t.ok(space.check(HEX))
  t.ok(space.check(HEX_DASHED))
  t.ok(space.check(encodeInvite({ topic: HEX, name: 'Acme', expiresAt: Date.now() + 1000 })))
  t.absent(space.check(''))
  t.absent(space.check(HEX.slice(1)))
  t.absent(space.check(encodeInvite({ topic: HEX }).slice(0, -4) + '$$$$'))
})

test('the relay check is the 111-char z-base-32 ticket, case-insensitive', (t) => {
  const { relay } = checks()
  t.is(TICKET.length, 111)
  t.ok(relay.check(TICKET))
  t.ok(relay.check(TICKET.toUpperCase()))
  t.absent(relay.check(TICKET.slice(0, 110)))
  t.absent(relay.check(TICKET + 'y'))
  t.absent(relay.check(HEX))
})

test('the license check wants the a/ form of an activation code', (t) => {
  const { license } = checks()
  t.ok(license.check(ACTIVATION))
  t.ok(license.check(ACTIVATION.toUpperCase().replace(/^A\//, 'a/')))
  t.absent(license.check(ACTIVATION.slice(2)), 'a bare code')
  t.absent(license.check('k/MRL-ABCDE-FGHIJ-KLMNO-PQRST-UVWXY'), 'the retired k/ form')
  t.absent(license.check('a/0000000000'), 'outside z-base-32')
})

test('the page keeps the payload in the fragment and off the wire', (t) => {
  t.ok(page.includes('<meta name="referrer" content="no-referrer">'))
  t.ok(page.includes('<meta name="robots" content="noindex">'))
  t.absent(/<form|fetch\(|XMLHttpRequest|<script[^>]+src=/.test(page), 'no form, no request, no external script')
})
