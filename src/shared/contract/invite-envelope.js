// Encode/decode the invite envelope — the base64url JSON payload behind an invite code /
// mirall://join deep link. It carries the swarm topic plus non-secret hints (space name,
// inviter, creator, schema version, per-link id, expiry). An invite is a bearer discovery
// token, not a capability: the space content key is never inside it, so holding an invite
// lets a peer knock, not read.
//
// The codec uses btoa/atob over a hand-rolled UTF-8 layer because those are the only text
// primitives all three runtimes share: Bare has no TextEncoder/TextDecoder, and Buffer is
// absent from the renderer. Malformed input collapses to U+FFFD exactly where TextDecoder
// would put it, so a code minted by any runtime decodes identically in the other two.
import { NAME_MAX } from './limits.js'

/**
 * @typedef {{ v: 0, topic: string }} DecodedInviteV0
 * @typedef {{ v: 1, topic: string, name?: string, owner?: string, ownerName?: string, creator?: string,
 *   schemaVersion?: number, autoAdmit?: boolean, inviteId?: string, expiresAt?: number }} DecodedInviteV1
 * @typedef {DecodedInviteV0 | DecodedInviteV1} DecodedInvite
 * @typedef {{ topic: string, name?: string, owner?: string, ownerName?: string, creator?: string,
 *   schemaVersion?: number, autoAdmit?: boolean, inviteId?: string, expiresAt?: number | null }} InviteFields
 * @typedef {{ v: 1, t: string, n?: string, o?: string, d?: string, c?: string, s?: number, a?: 1, id?: string, x?: number }} InviteWire
 */

const HEX64 = /^[0-9a-f]{64}$/i
const HEX32 = /^[0-9a-f]{32}$/i
const B64URL = /^[A-Za-z0-9_-]+$/
const SCHEMA_MAX = 2

/** @param {number | null | undefined} v */
const positiveInt = (v) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null)
/** @param {string | undefined} v @param {RegExp} re */
const hexOrNull = (v, re) => (typeof v === 'string' && re.test(v) ? v.toLowerCase() : null)
/** @param {string | undefined} v */
const nameOrNull = (v) => (typeof v === 'string' && v.length > 0 ? v.slice(0, NAME_MAX) : null)

/** @param {string} str */
function utf8Encode(str) {
  const bytes = []
  for (let i = 0; i < str.length; i++) {
    let cp = str.charCodeAt(i)
    if (cp >= 0xd800 && cp <= 0xdbff) {
      const low = i + 1 < str.length ? str.charCodeAt(i + 1) : 0
      if (low >= 0xdc00 && low <= 0xdfff) { cp = 0x10000 + ((cp - 0xd800) << 10) + (low - 0xdc00); i++ }
      else cp = 0xfffd
    } else if (cp >= 0xdc00 && cp <= 0xdfff) cp = 0xfffd
    if (cp < 0x80) bytes.push(cp)
    else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f))
    else if (cp < 0x10000) bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f))
    else bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f))
  }
  return bytes
}

// Returns [codePoint, bytesConsumed]. Overlong forms, surrogate code points and truncated
// sequences all yield U+FFFD over a single byte, which is what makes this agree with
// TextDecoder rather than merely resemble it.
/** @param {number[]} bytes @param {number} i @returns {[number, number]} */
function utf8CodePointAt(bytes, i) {
  const b0 = bytes[i]
  if (b0 < 0x80) return [b0, 1]
  const width = b0 >= 0xf0 && b0 <= 0xf4 ? 4 : b0 >= 0xe0 && b0 <= 0xef ? 3 : b0 >= 0xc2 && b0 <= 0xdf ? 2 : 0
  if (width === 0) return [0xfffd, 1]
  for (let k = 1; k < width; k++) {
    const b = bytes[i + k]
    if (b === undefined || b < 0x80 || b > 0xbf) return [0xfffd, 1]
  }
  let cp = b0 & (0xff >> (width + 1))
  for (let k = 1; k < width; k++) cp = (cp << 6) | (bytes[i + k] & 0x3f)
  const min = width === 2 ? 0x80 : width === 3 ? 0x800 : 0x10000
  if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return [0xfffd, 1]
  return [cp, width]
}

/** @param {number[]} bytes */
function utf8Decode(bytes) {
  let out = ''
  let i = 0
  while (i < bytes.length) {
    const [cp, size] = utf8CodePointAt(bytes, i)
    out += String.fromCodePoint(cp)
    i += size
  }
  return out
}

/** @param {string} str */
function b64urlEncode(str) {
  const bytes = utf8Encode(str)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** @param {string} s */
function b64urlDecode(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad)
  const bytes = new Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return utf8Decode(bytes)
}

// Reduce a value to the bare invite code. A mirall://join deep link (path form
// mirall://join/<code> or query form mirall://join?code=<code>) is peeled down to
// <code>; anything else passes through trimmed and unchanged, so a pasted link
// resolves to the same code as clicking it.
/** @param {string} input */
export function extractInviteCode(input) {
  if (typeof input !== 'string') return ''
  const trimmed = input.trim()
  let url
  try { url = new URL(trimmed) } catch { return trimmed } // not a URL → raw code
  if (url.protocol !== 'mirall:' || url.hostname !== 'join') return trimmed
  // Trailing slashes too: a link that round-tripped through a browser or chat
  // client can come back as mirall://join/<code>/, and neither hex nor base64url
  // contains '/', so stripping it can never eat part of a real code.
  const fromPath = url.pathname.replace(/^\/+|\/+$/g, '')
  const fromQuery = url.searchParams.get('code') ?? ''
  let raw = (fromPath || fromQuery).trim()
  try { raw = decodeURIComponent(raw) } catch {}
  return raw // bare code ('' if the link carried none)
}

// Optional inviter identity (o = profile public key, d = display name). Lets the
// joiner pre-seed the inviter as an offline shell member so the space isn't
// empty before the first handshake. Keyed by the real public key, so the
// handshake merges into the shell rather than adding a duplicate. Unauthenticated
// until that handshake — purely a placeholder. ownerName is only carried when a
// valid owner key is present.
// Optional space creator (c): the root the membership fold (an OR-Set) seeds from. Distinct from
// `owner` (the inviter, which can be any member) — the creator is the single peer with no approval
// record, so every peer must agree on it or honest member views diverge. Same trust status as `owner`.
// The remaining hints (s, a, id, x) are non-secret membership hints; the link's expiry is a
// joiner-side hint — the minting member's record is authoritative. None of these is a capability.
/** @param {Partial<InviteWire>} obj @returns {DecodedInviteV1 | null} */
function decodeInviteV1(obj) {
  const topic = hexOrNull(obj.t, HEX64)
  if (topic === null) return null
  /** @type {DecodedInviteV1} */
  const out = { v: 1, topic }
  const name = nameOrNull(obj.n)
  if (name !== null) out.name = name
  const owner = hexOrNull(obj.o, HEX64)
  if (owner !== null) {
    out.owner = owner
    const ownerName = nameOrNull(obj.d)
    if (ownerName !== null) out.ownerName = ownerName
  }
  const creator = hexOrNull(obj.c, HEX64)
  if (creator !== null) out.creator = creator
  const schema = positiveInt(obj.s)
  if (schema !== null && schema <= SCHEMA_MAX) out.schemaVersion = schema
  if (obj.a === 1) out.autoAdmit = true
  const inviteId = hexOrNull(obj.id, HEX32)
  if (inviteId !== null) out.inviteId = inviteId
  const expiry = positiveInt(obj.x)
  if (expiry !== null) out.expiresAt = expiry
  return out
}

/** @param {string} input @returns {DecodedInvite | null} */
export function decodeInvite(input) {
  if (typeof input !== 'string') return null
  const cleaned = extractInviteCode(input)
  if (!cleaned) return null

  const stripped = cleaned.replace(/-/g, '').toLowerCase()
  if (HEX64.test(stripped)) return { v: 0, topic: stripped }

  if (!B64URL.test(cleaned)) return null
  /** @type {Partial<InviteWire> | null} */
  let obj
  try { obj = JSON.parse(b64urlDecode(cleaned)) } catch { return null }
  if (!obj || typeof obj !== 'object' || obj.v !== 1) return null
  return decodeInviteV1(obj)
}

/** @param {InviteFields} fields */
export function encodeInvite({ topic, name, owner, ownerName, creator, schemaVersion, autoAdmit, inviteId, expiresAt }) {
  if (typeof topic !== 'string' || !HEX64.test(topic)) {
    throw new Error('encodeInvite: topic must be 64-char hex')
  }
  /** @type {InviteWire} */
  const obj = { v: 1, t: topic.toLowerCase() }
  const n = nameOrNull(name)
  if (n !== null) obj.n = n
  const o = hexOrNull(owner, HEX64)
  if (o !== null) {
    obj.o = o
    const d = nameOrNull(ownerName)
    if (d !== null) obj.d = d
  }
  const c = hexOrNull(creator, HEX64)
  if (c !== null) obj.c = c
  const schema = positiveInt(schemaVersion)
  if (schema !== null && schema >= 2) obj.s = schema
  if (autoAdmit) obj.a = 1
  const id = hexOrNull(inviteId, HEX32)
  if (id !== null) obj.id = id
  const expiry = positiveInt(expiresAt)
  if (expiry !== null) obj.x = expiry
  return b64urlEncode(JSON.stringify(obj))
}

export { HEX64, NAME_MAX }
