import test from 'brittle'
import { readFileSync, readdirSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { cloudSyncHint } from '../../src/shared/folders/path-keys.js'

// A test peer's temp dir is handed to the app as a mount root, so it crosses
// mount-validate. A base36 random suffix draws from [0-9a-z] and can therefore spell
// a cloud-sync hint ("box", "mega"), which mount-validate rejects with
// MOUNT_FORBIDDEN_CLOUD_SYNC — a rare, unreproducible red with no relation to the
// behavior under test. Hex is safe by construction, and that is what these pin.

const here = path.dirname(fileURLToPath(import.meta.url))
const testRoot = path.join(here, '..')

// Every dir whose names reach the app as a mount root or a download destination.
const SCANNED = ['flow', 'helpers', 'integration', 'raw', 'unit']
const HEX = /^[0-9a-f]*$/

function scannedFiles() {
  const out = []
  for (const dir of SCANNED) {
    for (const name of readdirSync(path.join(testRoot, dir))) {
      if (/\.(js|mjs)$/.test(name)) out.push(path.join(dir, name))
    }
  }
  return out
}

test('no cloud-sync hint is spellable in hex', (t) => {
  // The whole guarantee: every rejected substring carries at least one character
  // outside the hex alphabet, so no hex suffix of any length can contain one.
  const hints = ['dropbox', 'onedrive', 'google drive', 'icloud', 'box', 'nextcloud', 'mega', 'proton drive', 'pcloud']
  for (const hint of hints) {
    t.ok(cloudSyncHint(hint), `${hint} is a rejected substring`)
    t.absent(HEX.test(hint), `${hint} cannot be spelled in hex`)
  }
})

test('the generated suffix is hex, long enough to isolate concurrent runs, and hint-free', (t) => {
  let shortest = Infinity
  for (let i = 0; i < 50000; i++) {
    const suffix = Math.random().toString(16).slice(2, 8)
    if (!HEX.test(suffix)) return t.fail(`non-hex suffix ${suffix}`)
    if (cloudSyncHint(`/tmp/mirall-peer-a-1700000000000-${suffix}`)) return t.fail(`hint in ${suffix}`)
    shortest = Math.min(shortest, suffix.length)
  }
  t.ok(shortest >= 5, `>= 20 bits of suffix entropy (shortest sample: ${shortest} hex chars)`)
})

test('REGRESSION: no base36 temp-dir suffix in any dir whose names reach the app', (t) => {
  // Nothing in these dirs has a legitimate use for base36, so the whole call is the tell —
  // the suffix and the tmpdir() join are not always on the same line.
  const offenders = scannedFiles()
    // This file names the banned call in its own assertion.
    .filter((rel) => rel !== path.join('unit', 'tmp-dir-suffix-hygiene.test.js'))
    .filter((rel) => readFileSync(path.join(testRoot, rel), 'utf8').includes('toString(36)'))
  t.alike(offenders, [], 'temp-dir suffixes are hex')
})

// The pair with the test above: base36 is banned outright, and the hex that replaces it comes from
// the helper rather than being spelled out again. mkdtempSync is deliberately NOT flagged — it is
// the platform's own primitive, not a second spelling of ours. `unit` is scanned as defence in
// depth: its scratch dirs are fixtures, never handed to the app as a mount root.
test('the hex suffix comes from the helper, not from a second spelling', (t) => {
  const owners = [
    path.join('helpers', 'tmp.js'),
    path.join('helpers', 'bare-tmp.js'),
    // This file generates suffixes itself, to prove the alphabet claim above.
    path.join('unit', 'tmp-dir-suffix-hygiene.test.js'),
  ]
  const offenders = scannedFiles().filter((rel) => {
    if (owners.includes(rel)) return false
    // The vendored overlay suite keeps its own by deliberate exception — see its header.
    if (rel.endsWith('overlay-vendor-helpers.js')) return false
    return readFileSync(path.join(testRoot, rel), 'utf8').includes("Math.random().toString(16)")
  })
  t.alike(offenders.sort(), [], 'hex suffixes come from test/helpers/{tmp,bare-tmp}.js')
})
