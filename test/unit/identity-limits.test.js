import test from 'brittle'
import { clampDisplayName, sanitizeAvatar, AVATAR_MAX_BYTES } from '../../src/shared/identity-limits.js'
import { NAME_MAX } from '../../src/shared/invite-envelope.js'

const dataUri = (n, mime = 'image/png') => `data:${mime};base64,${'A'.repeat(n)}`

test('clampDisplayName truncates to NAME_MAX and coerces empties/non-strings', (t) => {
  t.is(clampDisplayName('x'.repeat(500)).length, NAME_MAX)
  t.is(clampDisplayName('Alice'), 'Alice')
  t.is(clampDisplayName(''), 'Unknown')
  t.is(clampDisplayName(undefined), 'Unknown')
  t.is(clampDisplayName(12345), 'Unknown')
})

test('REGRESSION (FIX-MIR-12): sanitizeAvatar drops an over-cap data URI', (t) => {
  const big = dataUri(AVATAR_MAX_BYTES + 1, 'image/jpeg')
  t.is(sanitizeAvatar(big), null, 'over the default cap → null')
})

test('REGRESSION (FIX-MIR-12): sanitizeAvatar rejects non-image / malformed values', (t) => {
  t.is(sanitizeAvatar('data:text/html;base64,PHNjcmlwdD4='), null, 'non-image data URI')
  t.is(sanitizeAvatar('https://evil.example/x.png'), null, 'http(s) src')
  t.is(sanitizeAvatar('javascript:alert(1)'), null, 'js src')
  t.is(sanitizeAvatar(''), null)
  t.is(sanitizeAvatar(null), null)
  t.is(sanitizeAvatar(42), null)
})

test('sanitizeAvatar passes a small well-formed image and honours custom/0 cap', (t) => {
  const ok = dataUri(64, 'image/jpeg')
  t.is(sanitizeAvatar(ok), ok, 'small jpeg passes')
  t.is(sanitizeAvatar(dataUri(100), 50), null, 'custom cap enforced')
  t.is(sanitizeAvatar(dataUri(100000), 0), dataUri(100000), 'cap 0 disables the size bound')
})

test('sanitizeAvatar accepts the common raster mime types', (t) => {
  for (const mime of ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif']) {
    const v = dataUri(32, mime)
    t.is(sanitizeAvatar(v), v, mime + ' passes')
  }
})
