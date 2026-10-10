import test from 'brittle'
import { readFileSync, readdirSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { cloudSyncRootViolation } from '../../src/shared/folders/path-keys.js'

// A test peer's temp dir is handed to the app as a mount root, so it crosses mount-validate, and
// its name must never read as a cloud-sync root. Those match a whole path segment, so a random
// suffix inside a longer name cannot form one whatever its alphabet. The suffix is spelled once,
// in test/helpers/{tmp,bare-tmp}.js.

const here = path.dirname(fileURLToPath(import.meta.url))
const testRoot = path.join(here, '..')

// Every dir whose names reach the app as a mount root or a download destination.
const SCANNED = ['flow', 'helpers', 'integration', 'invariants', 'raw', 'unit']
const HEX = /^[0-9a-f]*$/
const linux = { platform: 'linux', home: '/home/me', sep: '/', getEnv: () => undefined }

function scannedFiles() {
  const out = []
  for (const dir of SCANNED) {
    for (const name of readdirSync(path.join(testRoot, dir))) {
      if (/\.(js|mjs)$/.test(name)) out.push(path.join(dir, name))
    }
  }
  return out
}

test('REGRESSION (FIX-612): a temp-dir name spelling a provider name is not a cloud-sync root', (t) => {
  for (const suffix of ['box', 'mega', 'dropbox', 'onedrive', 'nextcloud', '0box9', 'megab0']) {
    const dir = `/tmp/mirall-peer-a-1700000000000-${suffix}-0`
    t.is(cloudSyncRootViolation(dir, linux), null, dir)
  }
})

test('the generated suffix is hex, long enough to isolate concurrent runs, and never a cloud-sync root', (t) => {
  let shortest = Infinity
  for (let i = 0; i < 50000; i++) {
    const suffix = Math.random().toString(16).slice(2, 8)
    if (!HEX.test(suffix)) return t.fail(`non-hex suffix ${suffix}`)
    if (cloudSyncRootViolation(`/tmp/mirall-peer-a-1700000000000-${suffix}`, linux)) return t.fail(`cloud root in ${suffix}`)
    shortest = Math.min(shortest, suffix.length)
  }
  t.ok(shortest >= 5, `>= 20 bits of suffix entropy (shortest sample: ${shortest} hex chars)`)
})

// The hex suffix comes from the helper rather than being spelled out again. mkdtempSync is
// deliberately NOT flagged — it is the platform's own primitive, not a second spelling of ours.
// `unit` is scanned as defence in depth: its scratch dirs are fixtures, never handed to the app as
// a mount root.
test('the hex suffix comes from the helper, not from a second spelling', (t) => {
  const owners = [
    path.join('helpers', 'tmp.js'),
    path.join('helpers', 'bare-tmp.js'),
    // This file generates suffixes itself, to prove the claims above.
    path.join('unit', 'tmp-dir-suffix-hygiene.test.js'),
  ]
  const offenders = scannedFiles().filter((rel) => {
    if (owners.includes(rel)) return false
    // The overlay engine suite keeps its own by deliberate exception — see its header.
    if (rel.endsWith('overlay-engine-helpers.js')) return false
    return readFileSync(path.join(testRoot, rel), 'utf8').includes("Math.random().toString(16)")
  })
  t.alike(offenders.sort(), [], 'hex suffixes come from test/helpers/{tmp,bare-tmp}.js')
})
