// The relay invite ticket: the wire format shared with mirall-relay. 69 bytes —
// version, relay public key, member seed, checksum — as z-base-32 behind a
// mirall://relay/ prefix. The format is frozen: mirall-relay pins the same vector.
//
// Not in src/shared/contract/ despite being a cross-repo contract: that package imports
// nothing (contract-declarations.test.js enforces it) so it can load in the renderer, and
// this needs blake2b. The renderer gets its verdict from main over relay:parse (parseRelayInput
// through the bridge); renderer/relay-key.ts only truncates a key for display.
//
// CHANGING THIS FILE IS A PROTOCOL CHANGE. test/unit/relay-ticket.test.js pins the
// vector mirall-relay pins too; if it fails, one side has drifted.
import b4a from 'b4a'
import z32 from 'z32'
import crypto from 'hypercore-crypto'
import idEncoding from 'hypercore-id-encoding'

export const TICKET_VERSION = 1
export const TICKET_BYTES = 69
// Load-bearing, and not redundant with the checksum. 111 z-base-32 characters carry 555
// bits for 552 bits of payload, so the final character is 3 slack bits and nothing else:
// z32.decode(payload.slice(0, 110)) returns the IDENTICAL 69 bytes, and both the version
// byte and the checksum pass. Losing the last character of a paste is the commonest
// clipboard failure there is, and this gate is the only thing that rejects it. Do not
// replace it with a byteLength check on the decoded buffer.
export const TICKET_CHARS = 111
export const TICKET_PREFIX = 'mirall://relay/'

const BODY_BYTES = 65
const CHECKSUM_BYTES = 4
// The longest form a relay KEY takes. A z-base-32 run longer than this is nobody's key, so a
// wrong-length one is a mangled invite rather than an unrecognisable paste — see parseRelayInput.
const LONGEST_KEY_CHARS = 64
const Z_BASE_32 = 'ybndrfg8ejkmcpqxot1uwisza345h769'

function isZ32(value) {
  if (value.length === 0) return false
  for (const char of value) {
    if (!Z_BASE_32.includes(char)) return false
  }
  return true
}

function checksum(body) {
  return crypto.hash(body).subarray(0, CHECKSUM_BYTES)
}

// The app never mints a ticket; this exists so the pinned vector is asserted against the
// codec rather than against a copied constant.
export function _encodeTicketForTests(relayPublicKey, memberSeed) {
  if (!b4a.isBuffer(relayPublicKey) || relayPublicKey.byteLength !== 32) throw new Error('relay key must be 32 bytes')
  if (!b4a.isBuffer(memberSeed) || memberSeed.byteLength !== 32) throw new Error('member seed must be 32 bytes')
  const bytes = b4a.alloc(TICKET_BYTES)
  bytes[0] = TICKET_VERSION
  b4a.copy(relayPublicKey, bytes, 1)
  b4a.copy(memberSeed, bytes, 33)
  b4a.copy(checksum(bytes.subarray(0, BODY_BYTES)), bytes, BODY_BYTES)
  return z32.encode(bytes)
}

export function decodeRelayKey(id) {
  if (typeof id !== 'string' || id.length === 0) return null
  try {
    const key = idEncoding.decode(id)
    return key.byteLength === 32 ? key : null
  } catch {
    return null
  }
}

// One entry point for the paste field. The lengths do not collide — 52/64/59 for a key,
// 111/126 for a ticket — so no mode switch is needed. Distinct error codes, never a generic
// "invalid": a key-based access control whose failure mode is "it silently never connects" is
// what this format exists to prevent.
//
// `incomplete-invite` is local to the app; the wire vocabulary shared with mirall-relay stays
// invalid-format / unsupported-version / checksum-failed. It exists because the length gate,
// not the checksum, is what catches a paste that lost its last character — and telling someone
// who pasted 110 of 111 characters that this "is not a relay key or an invite" is the least
// useful thing we could say about the commonest clipboard failure there is.
export function parseRelayInput(input) {
  if (typeof input !== 'string') return { ok: false, code: 'invalid-format' }
  const trimmed = input.trim()
  if (!trimmed) return { ok: false, code: 'invalid-format' }

  // The key path runs on the untouched string: lower-casing first would silently start
  // accepting upper-case z-base-32 keys, which today's decoder rejects.
  if (decodeRelayKey(trimmed)) {
    return { ok: true, kind: 'open', publicKey: idEncoding.normalize(trimmed) }
  }

  // Every interior space too, not just the ends: 111 characters soft-wrap in mail, chat and
  // PDFs, and a payload carrying a newline would otherwise fail the alphabet check and be
  // reported as unrecognisable rather than as the mangled invite it is.
  const lowered = trimmed.toLowerCase().replace(/\s+/g, '')
  const stripped = lowered.startsWith(TICKET_PREFIX) ? lowered.slice(TICKET_PREFIX.length) : lowered
  const payload = stripped.replace(/\/+$/, '')
  if (payload.length !== TICKET_CHARS) {
    const meantAnInvite = lowered.startsWith(TICKET_PREFIX) || (payload.length > LONGEST_KEY_CHARS && isZ32(payload))
    return { ok: false, code: meantAnInvite ? 'incomplete-invite' : 'invalid-format' }
  }

  let bytes
  try {
    bytes = z32.decode(payload)
  } catch {
    return { ok: false, code: 'invalid-format' }
  }
  if (bytes.byteLength !== TICKET_BYTES) return { ok: false, code: 'invalid-format' }

  // Version before checksum, so a future format reads as unsupported rather than corrupt.
  if (bytes[0] !== TICKET_VERSION) return { ok: false, code: 'unsupported-version' }
  if (!b4a.equals(checksum(bytes.subarray(0, BODY_BYTES)), bytes.subarray(BODY_BYTES))) {
    return { ok: false, code: 'checksum-failed' }
  }

  return {
    ok: true,
    kind: 'private',
    publicKey: idEncoding.encode(bytes.subarray(1, 33)),
    seed: b4a.from(bytes.subarray(33, 65)),
    payload,
  }
}
