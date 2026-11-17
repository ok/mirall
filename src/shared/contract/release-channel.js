// Maps a build to its release channel from the version string + dev flag.
//
// CI (.github/workflows/build-electron.yml) encodes the channel in the version
// suffix: `-beta.N` for the staging channel (shipped publicly as the "beta"
// download on the website /preview page), `-dev.N` for dev, and a bare semver
// for prod. `-staging.N` prerelease suffixes must keep resolving to the staging
// channel: installs in the field still carry versions with that suffix.
// In the contract package so main, the worker and the tests read one rule.
/**
 * @param {{ dev?: boolean, appVersion?: string | null }} [build]
 * @returns {'dev' | 'staging' | 'prod'}
 */
export function deriveChannel({ dev, appVersion } = {}) {
  if (dev) return 'dev'
  const v = appVersion || ''
  if (v.includes('-beta.') || v.includes('-staging.')) return 'staging'
  if (v.includes('-dev.')) return 'dev'
  return 'prod'
}

// The version a back end states in its hello-ack and run record: the build's version, or what a
// build without one is. Main compares a running back end's statement with this, for its own build.
/**
 * @param {{ dev?: boolean, appVersion?: string | null }} [build]
 * @returns {string}
 */
export function versionLabel({ dev, appVersion } = {}) {
  return appVersion || (dev ? 'dev' : 'unknown')
}
