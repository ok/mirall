import test from 'brittle'
import { parseBootArgv, extractDeepLinks } from '../../src/main/boot-argv.js'

const OPTS = { name: 'Mirall', protocol: 'mirall' }
// A real v1 envelope link: base64url JSON, no '/' in it, so nothing about the
// payload makes it look like a flag or a path.
const LINK = 'mirall://join/eyJ2IjoxLCJ0IjoiNjNmNDEzNjI4YjI3NjdhZGEyNzI0OGFkYmZjY2I2MzZjM2Y2NzNmNmU3NGQ4YzJmNmY3ZDVlNGIzYzJhMWQwZiIsIm4iOiJBY21lIn0'

// REGRESSION (FIX-DEEPLINK-ARGV-1: clicking a mirall:// link on Windows/Linux killed
// the main process). paparam is strict about positionals, so the deep-link URL that
// the OS appends to argv bailed with UNKNOWN_ARG while main.js was still evaluating —
// Electron's "A JavaScript error occurred in the main process" dialog, no window, and
// (for a second instance) no chance for the running app to receive the link.
test('REGRESSION (FIX-DEEPLINK-ARGV-1): a deep link in argv parses instead of throwing', (t) => {
  const boot = parseBootArgv([LINK], OPTS)
  t.alike(boot.deepLinks, [LINK], 'the URL is peeled off for dispatch')
  t.alike(boot.warnings, [], 'and is not reported as an unknown argument')
})

test('flags still parse when a deep link shares the argv', (t) => {
  const boot = parseBootArgv(['--hidden', LINK, '--storage', '/tmp/x'], OPTS)
  t.is(boot.flags.hidden, true)
  t.is(boot.flags.storage, '/tmp/x', 'a flag after the URL is not swallowed as rest')
  t.alike(boot.deepLinks, [LINK])
})

test('declared flags parse with no deep link present', (t) => {
  const boot = parseBootArgv(['--storage', '/data', '--no-updates', '--no-sandbox'], OPTS)
  t.is(boot.flags.storage, '/data')
  t.is(boot.flags.updates, false)
  t.alike(boot.deepLinks, [])
  t.alike(boot.warnings, [])
})

test('an empty argv yields defaults, not a bail', (t) => {
  const boot = parseBootArgv([], OPTS)
  t.alike(boot.deepLinks, [])
  t.alike(boot.warnings, [])
  t.is(boot.flags.hidden, false, 'declared boolean flags default to false')
  t.not(boot.flags.updates, false, 'updates stay on unless --no-updates is passed')
})

// The point of the bail handler: argv is OS-written, so an unrecognised token has
// to degrade to a warning. Anything fatal here is fatal before a window exists.
test('an unknown argument warns instead of throwing', (t) => {
  let boot = null
  t.execution(() => { boot = parseBootArgv(['C:\\Users\\x\\some.file'], OPTS) }, 'does not throw')
  t.is(boot.warnings.length, 1)
  t.ok(boot.warnings[0].includes('UNKNOWN_ARG'), 'the offending token is reported')
  t.ok(boot.flags && typeof boot.flags === 'object', 'flags survives a bail')
})

test('an unknown flag warns instead of throwing', (t) => {
  let boot = null
  t.execution(() => { boot = parseBootArgv(['--not-a-flag'], OPTS) }, 'does not throw')
  t.is(boot.warnings.length, 1)
  t.alike(boot.deepLinks, [])
})

test('non-string and missing argv entries are ignored', (t) => {
  const boot = parseBootArgv([undefined, LINK, null, '--hidden'], OPTS)
  t.alike(boot.deepLinks, [LINK])
  t.is(boot.flags.hidden, true)
  t.alike(parseBootArgv(undefined, OPTS).deepLinks, [])
})

// URL schemes are case-insensitive and Windows hands back whatever was written.
test('extractDeepLinks matches the scheme case-insensitively, in argv order', (t) => {
  t.alike(extractDeepLinks(['Mirall://join/abc', 'MIRALL://join/def'], 'mirall'),
    ['Mirall://join/abc', 'MIRALL://join/def'])
  t.alike(extractDeepLinks(['x', 'mirall://join/a', 'y', 'mirall://join/b'], 'mirall'),
    ['mirall://join/a', 'mirall://join/b'])
})

test('extractDeepLinks ignores lookalikes and a missing protocol', (t) => {
  t.alike(extractDeepLinks(['mirallx://join/a', 'https://mirall.app/join/b', 'mirall:join/c'], 'mirall'), [])
  t.alike(extractDeepLinks(['mirall://join/a'], ''), [])
  t.alike(extractDeepLinks(['mirall://join/a'], undefined), [])
})
