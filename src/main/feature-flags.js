const fs = require('fs')
const path = require('path')

// Feature flags ship with the app in feature-flags.json at the package root
// (the repo root in dev, inside app.asar when packaged). The file is read ONCE
// at boot (primeFeatureFlags, called from main.js preloadAsarCache) and cached.
//
// Why a boot cache instead of reading on demand: the path is asar-internal, and
// the OTA updater wraps its _update/applyUpdate calls in `process.noAsar = true`
// (see main.js getPear). Under noAsar, Electron resolves the .asar path on the
// real filesystem — app.asar is a file, not a directory, so the read throws
// ENOTDIR. A lazy read that lands in that window would silently fall back to {}
// and degrade EVERY flag to false for the worker's whole lifetime, including the
// security gates (membership approval, handshake identity binding). Priming
// before getPear opens the noAsar window
// (the same defence preloadAsarCache already uses for the UI cache and the
// worker entrypoint) makes flag reads immune to the race.

// feature-flags.js lives in src/main/, so two levels up is the package root —
// the same location app.getAppPath() resolves to (dev: repo root; packaged:
// app.asar root), and the convention preloadAsarCache uses.
const DEFAULT_ROOT = path.join(__dirname, '..', '..')

let cache = null

function loadFromDisk(rootDir) {
  try {
    const raw = fs.readFileSync(path.join(rootDir, 'feature-flags.json'), 'utf-8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') return parsed
    console.warn('[mirall] feature-flags.json is not a JSON object — using defaults')
  } catch (err) {
    // Never swallow silently: a failed read collapses every flag to false, so a
    // warning is the only signal that the app is running degraded.
    console.warn('[mirall] failed to read feature-flags.json:', err.message)
  }
  return {}
}

// Read + cache the on-disk flags once, before the OTA updater's noAsar window
// can open. Idempotent; safe to call again (re-reads while noAsar is still off).
function primeFeatureFlags(rootDir = DEFAULT_ROOT) {
  cache = loadFromDisk(rootDir)
  return cache
}

// Resolved flags = boot cache (or, defensively, a direct read if called before
// prime) merged with the MIRALL_FEATURE_FLAGS env override (dev/test, never an
// asar read). Returns a fresh object so callers can't mutate the cache.
function readFeatureFlags() {
  const flags = { ...(cache ?? loadFromDisk(DEFAULT_ROOT)) }
  if (process.env.MIRALL_FEATURE_FLAGS) {
    try {
      const override = JSON.parse(process.env.MIRALL_FEATURE_FLAGS)
      if (override && typeof override === 'object') Object.assign(flags, override)
    } catch (err) {
      console.warn('[mirall] ignoring malformed MIRALL_FEATURE_FLAGS:', err.message)
    }
  }
  return flags
}

// Test-only: drop the boot cache between cases.
function __resetForTest() {
  cache = null
}

module.exports = { primeFeatureFlags, readFeatureFlags, __resetForTest }
