const fs = require('fs')
const path = require('path')

// Feature flags ship with the app in feature-flags.json at the package root (the repo root in
// dev, inside app.asar when packaged), read ONCE at boot (primeFeatureFlags, from main.js
// preloadAsarCache) and cached. A lazy read could land inside the OTA updater's noAsar window
// (see wrapWithNoAsar in main.js), fall back to {} and silently revert EVERY flag to its runtime
// default for the worker's whole lifetime.

// Two levels up from src/main/ is the package root — what app.getAppPath() resolves to in both
// dev and packaged builds, and the convention preloadAsarCache uses.
const DEFAULT_ROOT = path.join(__dirname, '..', '..')

let cache = null

function loadFromDisk(rootDir) {
  try {
    const raw = fs.readFileSync(path.join(rootDir, 'feature-flags.json'), 'utf-8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') return parsed
    console.warn('[mirall] feature-flags.json is not a JSON object — using defaults')
  } catch (err) {
    // Never swallow silently: a failed read reverts every flag to its runtime default, so a
    // warning is the only signal that the app is not running the shipped flags.
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

// Resolved flags = boot cache (or, defensively, a direct read if called before prime) merged with
// an override JSON object the caller supplies (the MIRALL_FEATURE_FLAGS lever, already gated by the
// caller). Returns a fresh object so callers can't mutate the cache.
/** @param {string | undefined} [overrideJson] */
function readFeatureFlags(overrideJson) {
  const flags = { ...(cache ?? loadFromDisk(DEFAULT_ROOT)) }
  if (overrideJson) {
    try {
      const override = JSON.parse(overrideJson)
      if (override && typeof override === 'object') Object.assign(flags, override)
    } catch (err) {
      console.warn('[mirall] ignoring malformed MIRALL_FEATURE_FLAGS:', err.message)
    }
  }
  return flags
}

// The flags the renderer may observe, resolved once for the config store's snapshot.
function rendererFeatures(overrideJson) {
  return { localBackup: readFeatureFlags(overrideJson).localBackup === true }
}

// Test-only: drop the boot cache between cases.
function _resetForTests() {
  cache = null
}

// test seam: _resetForTests is exported for tests only.
module.exports = { primeFeatureFlags, readFeatureFlags, rendererFeatures, _resetForTests }
