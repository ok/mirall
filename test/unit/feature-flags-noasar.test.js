import test from 'brittle'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { primeFeatureFlags, readFeatureFlags, __resetForTest } from '../../src/main/feature-flags.js'

// The shipped bug: feature-flags.json is asar-internal, and the OTA updater
// wraps _update/applyUpdate in `process.noAsar = true` (see main.js getPear).
// readFeatureFlags() used to read the asar path lazily, inside getWorker — which
// runs AFTER getPear installs the noAsar wrappers — so a read landing in that
// window threw ENOTDIR, the silent catch returned {}, and EVERY flag (overlay,
// inPlaceFiles, and the MIR-03 security gate) fell to false for the worker's
// whole lifetime. A restart that didn't overlap an update read the flags fine —
// the intermittency the user observed. The fix reads + caches the file once at
// boot (primeFeatureFlags, in preloadAsarCache, before the noAsar window opens).

const TAG = '[mirall]'

function captureWarn(t) {
  const real = console.warn
  const lines = []
  console.warn = (...a) => { if (typeof a[0] === 'string' && a[0].startsWith(TAG)) { lines.push(a.join(' ')); return } real(...a) }
  t.teardown(() => { console.warn = real })
  return lines
}

function tmpRootWith(flags) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirall-flags-'))
  if (flags !== undefined) fs.writeFileSync(path.join(dir, 'feature-flags.json'), typeof flags === 'string' ? flags : JSON.stringify(flags))
  return dir
}

function resetEnv(t) {
  const saved = process.env.MIRALL_FEATURE_FLAGS
  t.teardown(() => { if (saved === undefined) delete process.env.MIRALL_FEATURE_FLAGS; else process.env.MIRALL_FEATURE_FLAGS = saved })
  delete process.env.MIRALL_FEATURE_FLAGS
}

test('REGRESSION (FIX: feature flags survive the OTA noAsar read window): the boot cache holds even after the file becomes unreadable', (t) => {
  __resetForTest()
  resetEnv(t)
  const dir = tmpRootWith({ overlay: true, inPlaceFiles: true, handshakeIdentityBinding: true })

  // Boot read (before the noAsar window) succeeds and caches.
  primeFeatureFlags(dir)

  // Now the asar path becomes unreadable — exactly what process.noAsar=true does
  // to an in-asar path (ENOTDIR). Delete the file to model that failure.
  fs.rmSync(path.join(dir, 'feature-flags.json'))

  const flags = readFeatureFlags()
  t.is(flags.overlay, true, 'overlay stays true from the boot cache (would be undefined on a fresh racy read)')
  t.is(flags.inPlaceFiles, true, 'inPlaceFiles stays true')
  t.is(flags.handshakeIdentityBinding, true, 'security-gate flag stays true — not silently disabled')
})

test('primeFeatureFlags parses the on-disk flags', (t) => {
  __resetForTest()
  resetEnv(t)
  const dir = tmpRootWith({ overlay: true })
  primeFeatureFlags(dir)
  const flags = readFeatureFlags()
  t.is(flags.overlay, true)
})

test('a missing/unreadable file falls back to {} AND logs a warning (never silent)', (t) => {
  __resetForTest()
  resetEnv(t)
  const warns = captureWarn(t)
  const dir = tmpRootWith(undefined) // no feature-flags.json written
  primeFeatureFlags(dir)
  const flags = readFeatureFlags()
  t.is(flags.overlay, undefined, 'absent flag is undefined (=== true checks → false), not a crash')
  t.ok(warns.some((l) => l.includes('failed to read feature-flags.json')), 'a read failure is logged')
})

test('invalid (non-object) JSON falls back to {} with a warning', (t) => {
  __resetForTest()
  resetEnv(t)
  const warns = captureWarn(t)
  const dir = tmpRootWith('"a string, not an object"')
  primeFeatureFlags(dir)
  t.is(readFeatureFlags().overlay, undefined)
  t.ok(warns.some((l) => l.includes('not a JSON object')), 'non-object content is warned')
})

test('MIRALL_FEATURE_FLAGS overrides the cached base (dev/test escape hatch)', (t) => {
  __resetForTest()
  resetEnv(t)
  const dir = tmpRootWith({ overlay: true, inPlaceFiles: true })
  primeFeatureFlags(dir)
  process.env.MIRALL_FEATURE_FLAGS = JSON.stringify({ overlay: false })
  const flags = readFeatureFlags()
  t.is(flags.overlay, false, 'env override wins over cached value')
  t.is(flags.inPlaceFiles, true, 'un-overridden cached flag is preserved')
})

test('malformed MIRALL_FEATURE_FLAGS is ignored (with a warning), base preserved', (t) => {
  __resetForTest()
  resetEnv(t)
  const warns = captureWarn(t)
  const dir = tmpRootWith({ overlay: true })
  primeFeatureFlags(dir)
  process.env.MIRALL_FEATURE_FLAGS = '{not json'
  const flags = readFeatureFlags()
  t.is(flags.overlay, true, 'base survives a malformed override')
  t.ok(warns.some((l) => l.includes('ignoring malformed MIRALL_FEATURE_FLAGS')), 'malformed override is warned')
})

// Structural invariant — the behavioural tests above prove the cache works, but
// can't prove main.js primes it in the right place. The real ENOTDIR-under-
// noAsar race only exists in Electron+asar, so (as in msix-manager-preload.test)
// pin the source-level contract: the prime must live INSIDE preloadAsarCache
// (which runs in whenReady, before getPear opens the noAsar window), and main.js
// must not reintroduce a lazy asar read of feature-flags.json.
const here = path.dirname(fileURLToPath(import.meta.url))
const mainSrc = readFileSync(path.join(here, '..', '..', 'src', 'main', 'main.js'), 'utf8')

test('REGRESSION (structural): preloadAsarCache primes feature flags before the noAsar window, and no lazy asar read remains', (t) => {
  const body = mainSrc.match(/function preloadAsarCache\s*\(\)\s*\{([\s\S]*?)\n\}/)
  t.ok(body, 'preloadAsarCache() exists')
  t.ok(/primeFeatureFlags\s*\(/.test(body[1]), 'preloadAsarCache calls primeFeatureFlags() before getPear opens the noAsar window')

  t.ok(/require\(['"]\.\/feature-flags(\.js)?['"]\)/.test(mainSrc), "main.js requires './feature-flags.js'")
  t.absent(/readFileSync\([^)]*getAppPath\(\)[^)]*feature-flags\.json/.test(mainSrc),
    'main.js no longer does a lazy fs read of the asar feature-flags.json path')
})

test('the relay flag is opt-in: absent, degraded, and explicit-false all read off', (t) => {
  __resetForTest()
  resetEnv(t)

  // Absent from the shipped file — the state this feature ships in.
  primeFeatureFlags(tmpRootWith({ overlay: true, inPlaceFiles: true }))
  t.is(readFeatureFlags().relay === true, false, 'a missing key means off')

  // A failed / malformed read collapses every flag to {} — relay must fall off, not on.
  __resetForTest()
  primeFeatureFlags(tmpRootWith(undefined))
  t.is(readFeatureFlags().relay === true, false, 'an unreadable flag file means off')

  __resetForTest()
  primeFeatureFlags(tmpRootWith({ relay: false }))
  t.is(readFeatureFlags().relay === true, false)
})

test('the relay flag turns on via the file or the env escape hatch', (t) => {
  __resetForTest()
  resetEnv(t)

  primeFeatureFlags(tmpRootWith({ relay: true }))
  t.is(readFeatureFlags().relay === true, true, 'flipped in feature-flags.json')

  __resetForTest()
  primeFeatureFlags(tmpRootWith({ overlay: true }))
  t.is(readFeatureFlags().relay === true, false)
  process.env.MIRALL_FEATURE_FLAGS = JSON.stringify({ relay: true })
  t.is(readFeatureFlags().relay === true, true, 'MIRALL_FEATURE_FLAGS enables it without a build')
})
