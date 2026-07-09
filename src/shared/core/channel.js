// Maps a build to its release channel from the version string + dev flag.
//
// CI (.github/workflows/build-electron.yml) encodes the channel in the version
// suffix: `-beta.N` for the staging channel (shipped publicly as the "beta"
// download on the website /preview page), `-dev.N` for dev, and a bare semver
// for prod. `-staging.N` prerelease suffixes must keep resolving to the staging
// channel: installs in the field still carry versions with that suffix.
//
// Kept dependency-free so it's unit-testable without pulling in bare-* modules
// (feedback.js, which consumes this, imports bare-https).
export function deriveChannel ({ dev, appVersion } = {}) {
  if (dev) return 'dev'
  const v = appVersion || ''
  if (v.includes('-beta.') || v.includes('-staging.')) return 'staging'
  if (v.includes('-dev.')) return 'dev'
  return 'prod'
}
