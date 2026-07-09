import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

// theme-bootstrap.js is a classic <script> (no import/export). Exercise the
// real file by evaluating its text against a fake DOM and reading back the
// scheme it commits to <html> at first paint.
const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = fs.readFileSync(path.join(HERE, '../../assets/theme-bootstrap.js'), 'utf8')

// configTheme = config.json value returned by window.bridge.getConfig();
// legacyTheme = localStorage['mirall:theme']; prefersDark = OS scheme.
function bootScheme({ configTheme = null, legacyTheme = null, prefersDark = false, hasBridge = true } = {}) {
  let scheme = null
  const html = { classList: { add: (c) => { scheme = c } }, style: {} }
  const window = { matchMedia: () => ({ matches: prefersDark }) }
  if (hasBridge) window.bridge = { getConfig: () => ({ appearance: { theme: configTheme } }) }
  const document = { documentElement: html }
  const localStorage = { getItem: (k) => (k === 'mirall:theme' ? legacyTheme : null) }
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'localStorage', SRC)(window, document, localStorage)
  return scheme
}

test('REGRESSION (theme boot cache): first paint follows config.json, not the OS guess', (t) => {
  // Before the fix the pre-paint script read only the write-dead
  // localStorage['mirall:theme'] key (deleted after the config.json migration,
  // never re-written), so it fell back to 'system' and flashed the wrong theme
  // on every launch for a user whose explicit choice differs from their OS.
  t.is(bootScheme({ configTheme: 'dark', prefersDark: false }), 'dark', 'dark config on a light OS → dark')
  t.is(bootScheme({ configTheme: 'light', prefersDark: true }), 'light', 'light config on a dark OS → light')
})

test('theme boot: system follows the OS scheme', (t) => {
  t.is(bootScheme({ configTheme: 'system', prefersDark: true }), 'dark')
  t.is(bootScheme({ configTheme: 'system', prefersDark: false }), 'light')
})

test('theme boot: legacy localStorage is the fallback when config carries no theme', (t) => {
  // The single boot right after migration, before config.json holds the value.
  t.is(bootScheme({ configTheme: null, legacyTheme: 'dark', prefersDark: false }), 'dark')
})

test('theme boot: config takes precedence over legacy localStorage', (t) => {
  t.is(bootScheme({ configTheme: 'dark', legacyTheme: 'light', prefersDark: false }), 'dark')
})

test('theme boot: no bridge + no legacy value → system default', (t) => {
  t.is(bootScheme({ hasBridge: false, prefersDark: true }), 'dark')
  t.is(bootScheme({ hasBridge: false, prefersDark: false }), 'light')
})
