// An open relay admits anyone who knows its key; a private one admits the member identities its
// operator minted invites for.
export const RELAY_KINDS = Object.freeze(/** @type {const} */ (['open', 'private']))

// How a relay key is shown wherever it is not the configuration itself: its first eight and last
// six characters. The Activity Log stores this form, so a row and Settings name a relay alike.

/** @param {string} key @returns {string} */
export function truncateRelayKey(key) {
  return key.length <= 16 ? key : `${key.slice(0, 8)}…${key.slice(-6)}`
}
