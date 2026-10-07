import test from 'brittle'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const HELPER = path.join(here, '..', '..', 'scripts', 'build', 'lib', 'fetch-verified.sh')
const BYTES = 'uruntime stand-in\n'
const PIN = createHash('sha256').update(BYTES).digest('hex')

function scratch(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'fetch-verified-'))
  t.teardown(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

// Sourced under `set -euo pipefail` as build-app-image.sh sources it; CONTINUED prints only if a
// failure did not stop the calling script.
function runHelper(call, args) {
  const script = `set -euo pipefail; source "$1"; shift; ${call} "$@"; echo CONTINUED`
  const result = spawnSync('bash', ['-c', script, 'fetch-verified', HELPER, ...args], { encoding: 'utf8' })
  return { code: result.status, stdout: result.stdout, stderr: result.stderr }
}

function fetchFixture(t, expected, url) {
  const dir = scratch(t)
  const source = path.join(dir, 'asset')
  writeFileSync(source, BYTES)
  const out = path.join(dir, 'out')
  return { out, ...runHelper('fetch_verified', [url ?? pathToFileURL(source).href, expected, out]) }
}

test('REGRESSION (MIR-55: a build input whose hash differs from its pin stops the build)', (t) => {
  const wrong = PIN.replace(/^./, (c) => (c === '0' ? '1' : '0'))
  const r = fetchFixture(t, wrong)
  t.not(r.code, 0, 'non-zero exit')
  t.absent(r.stdout.includes('CONTINUED'), 'the calling script does not go on')
  t.absent(existsSync(r.out), 'the rejected file is deleted')
  t.ok(r.stderr.includes(`expected ${wrong}`), 'the pin is reported')
  t.ok(r.stderr.includes(`actual   ${PIN}`), 'the actual hash is reported')
})

test('a build input matching its pin is kept byte for byte', (t) => {
  const r = fetchFixture(t, PIN)
  t.is(r.code, 0)
  t.ok(r.stdout.includes('CONTINUED'))
  t.is(readFileSync(r.out, 'utf8'), BYTES)
})

test('an empty or malformed pin is refused, never read as "no check"', (t) => {
  for (const pin of ['', PIN.toUpperCase(), PIN.slice(0, 63), `${PIN}0`]) {
    const r = fetchFixture(t, pin)
    t.not(r.code, 0, `pin of length ${pin.length} is refused`)
    t.absent(existsSync(r.out), 'nothing is left behind')
  }
})

test('a failed download stops the build', (t) => {
  const missing = pathToFileURL(path.join(scratch(t), 'no-such-asset')).href
  const r = fetchFixture(t, PIN, missing)
  t.not(r.code, 0)
  t.absent(r.stdout.includes('CONTINUED'))
  t.ok(r.stderr.includes('download failed'))
})

test('a file that drifted from its pin after download is refused and deleted', (t) => {
  const file = path.join(scratch(t), 'runtime')
  writeFileSync(file, `${BYTES}patched\n`)
  const r = runHelper('verify_sha256', [file, PIN])
  t.not(r.code, 0)
  t.absent(r.stdout.includes('CONTINUED'))
  t.absent(existsSync(file))
})
