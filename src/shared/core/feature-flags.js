// The shipped feature flags, read once at worker start from feature-flags.json at the package root
// and merged under a host-supplied override. A missing or malformed file reverts every flag to its
// runtime default; that is logged, never thrown, because the flags gate behaviour the worker can
// run without.
import fs from 'bare-fs'
import path from 'bare-path'

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

export function loadFeatureFlags(packageRoot, { override = null, log = console } = {}) {
  let flags = {}
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(packageRoot, 'feature-flags.json'), 'utf-8'))
    if (isPlainObject(parsed)) flags = parsed
    else log.warn('feature-flags.json is not a JSON object — using defaults')
  } catch (err) {
    log.warn('failed to read feature-flags.json:', err.message)
  }
  return isPlainObject(override) ? { ...flags, ...override } : flags
}
