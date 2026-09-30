// Which question a key answers. An org holds the contract, a person holds the seat, a device is one
// install — so "whose is this?" and "which machine?" are two questions, and a consumer generating
// types from this package has to be able to ask them apart.
//
// Today every answer is the same value: an install's person key, its device key and the
// `profileKey` it puts on the wire are all the hex manifest hash of its profile core. principalRef
// is the one place that equality is written down, so the day a device roster exists there is one
// site to change rather than every payload that carries a key.
//
// A transport key is none of these. A Noise key identifies a socket, lives only as long as that
// socket, and differs between a peer's control and content connections — folding by it shows one
// person twice — so it is named noiseKey wherever it appears.

/**
 * Hex key of the human holding a seat: the identity peers pin, vouch for and attribute to.
 * @typedef {string} PersonKey
 */

/**
 * Hex key of one install. Equal to the person key until a device roster exists.
 * @typedef {string} DeviceKey
 */

/**
 * Hex key of the contract holder. Representable everywhere a principal is, and null on every
 * install today — the shape must not preclude the org tier, and nothing asserts it yet.
 * @typedef {string} OrgKey
 */

/**
 * Ephemeral hex key of one socket's Noise handshake. Never an identity.
 * @typedef {string} NoiseKey
 */

/** @typedef {{ personKey: PersonKey, deviceKey: DeviceKey, orgKey: OrgKey | null }} PrincipalRef */

const PERSON_KEY = /^[0-9a-f]{64}$/

// The one spelling a person key has in every record and on every request: lowercase hex of 32
// bytes. Keys are opened as cores and compared as strings, so an uppercase or overlong spelling is
// a second name for one core and a short one names none. Membership reads, the join-request ingest
// and the requests that name a member admit a key only through this check.
/** @param {string} value @returns {boolean} */
export function isPersonKey(value) {
  return typeof value === 'string' && PERSON_KEY.test(value)
}

// The grandfathering rule, stated once: an install's profile key is simultaneously its person key
// and its device key, and it belongs to no org. A second device attests to the same person key
// later; until then the two questions are both legal to ask and the answers agree.
/** @param {string} profileKey @param {OrgKey | null} [orgKey] @returns {PrincipalRef} */
export function principalRef(profileKey, orgKey = null) {
  return { personKey: profileKey, deviceKey: profileKey, orgKey }
}
