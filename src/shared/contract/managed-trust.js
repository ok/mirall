// The Ed25519 public keys that sign organization configuration, per release channel, as hex. A bundle
// verifies only against these, so a key reaches users only through a reviewed change and a release.
// Active first, then standby. An empty list leaves the feature dormant on that channel.
const PRODUCTION_ACTIVE = '3759cc93c535317e18e78d4b5682db34f71762fcb56bc05b17781942f16805f3'
const PRODUCTION_STANDBY = 'd81dcc0b0ce4780000bbbd268d87054731f0d57b2af730ef708e2878fc01b0d0'
const STAGING_ACTIVE = '3b6bf0ebd153d0fabd9a1d61074756b20380f91ceddc692cd7507c46a4456a61'

// Beta (the staging channel) is a public download, so it trusts the production Console as well as
// the staging one that internal tests use.
export const PINNED_SIGNING_KEYS = Object.freeze({
  prod: Object.freeze([PRODUCTION_ACTIVE, PRODUCTION_STANDBY]),
  staging: Object.freeze([PRODUCTION_ACTIVE, PRODUCTION_STANDBY, STAGING_ACTIVE]),
  dev: Object.freeze([STAGING_ACTIVE]),
})

/** @typedef {keyof typeof PINNED_SIGNING_KEYS} ManagedChannel */

/**
 * @param {string} channel
 * @param {Readonly<Record<ManagedChannel, readonly string[]>>} [pinned]
 * @returns {boolean}
 */
export function hasManagedTrust(channel, pinned = PINNED_SIGNING_KEYS) {
  return (channel === 'prod' || channel === 'staging' || channel === 'dev') && pinned[channel].length > 0
}
