// The Ed25519 public keys that sign organization configuration, per release channel, as hex. A bundle
// verifies only against these, so a key reaches users only through a reviewed change and a release.
// Active first, then standby. An empty list leaves the feature dormant on that channel.
const STAGING_ACTIVE = '3b6bf0ebd153d0fabd9a1d61074756b20380f91ceddc692cd7507c46a4456a61'

export const PINNED_SIGNING_KEYS = Object.freeze({
  prod: Object.freeze(/** @type {string[]} */ ([])),
  staging: Object.freeze([STAGING_ACTIVE]),
  dev: Object.freeze([STAGING_ACTIVE]),
})

/** @typedef {keyof typeof PINNED_SIGNING_KEYS} ManagedChannel */

/**
 * @param {string} channel
 * @returns {boolean}
 */
export function hasManagedTrust(channel) {
  return (channel === 'prod' || channel === 'staging' || channel === 'dev') && PINNED_SIGNING_KEYS[channel].length > 0
}
