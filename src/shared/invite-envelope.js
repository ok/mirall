// Encode/decode the invite envelope — the base64url JSON payload behind an invite code /
// mirall://join deep link. It carries the swarm topic plus non-secret hints (space name,
// inviter, creator, schema version, per-link id, expiry). An invite is a bearer discovery
// token, not a capability: the space content key is never inside it, so holding an invite
// lets a peer knock, not read.
import b4a from 'b4a'

const HEX64 = /^[0-9a-f]{64}$/i
const HEX32 = /^[0-9a-f]{32}$/i
const B64URL = /^[A-Za-z0-9_-]+$/
const NAME_MAX = 80
const SCHEMA_MAX = 2

function b64urlEncode(str) {
  return b4a.toString(b4a.from(str, 'utf8'), 'base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlDecode(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  const std = s.replace(/-/g, '+').replace(/_/g, '/') + pad
  return b4a.toString(b4a.from(std, 'base64'), 'utf8')
}

// Reduce a value to the bare invite code. A mirall://join deep link (path form
// mirall://join/<code> or query form mirall://join?code=<code>) is peeled down to
// <code>; anything else passes through trimmed and unchanged. Mirrors
// src/main/deeplink.js and the renderer copy so a pasted link resolves to the
// same code as clicking it, even when it reaches the data layer directly.
export function extractInviteCode(input) {
  if (typeof input !== 'string') return ''
  const trimmed = input.trim()
  let url
  try { url = new URL(trimmed) } catch { return trimmed } // not a URL → raw code
  if (url.protocol !== 'mirall:' || url.hostname !== 'join') return trimmed
  const fromPath = url.pathname.replace(/^\/+/, '')
  const fromQuery = url.searchParams.get('code') ?? ''
  let raw = (fromPath || fromQuery).trim()
  try { raw = decodeURIComponent(raw) } catch {}
  return raw // bare code ('' if the link carried none)
}

export function decodeInvite(input) {
  if (typeof input !== 'string') return null
  const cleaned = extractInviteCode(input)
  if (!cleaned) return null

  const stripped = cleaned.replace(/-/g, '').toLowerCase()
  if (HEX64.test(stripped)) return { v: 0, topic: stripped }

  if (!B64URL.test(cleaned)) return null
  let obj
  try { obj = JSON.parse(b64urlDecode(cleaned)) } catch { return null }
  if (!obj || typeof obj !== 'object') return null
  if (obj.v !== 1) return null
  if (typeof obj.t !== 'string' || !HEX64.test(obj.t)) return null

  const out = { v: 1, topic: obj.t.toLowerCase() }
  if (typeof obj.n === 'string' && obj.n.length > 0) {
    out.name = obj.n.slice(0, NAME_MAX)
  }
  // Optional inviter identity (o = profile public key, d = display name). Lets the
  // joiner pre-seed the inviter as an offline shell member so the space isn't
  // empty before the first handshake. Keyed by the real public key, so the
  // handshake merges into the shell rather than adding a duplicate. Unauthenticated
  // until that handshake — purely a placeholder. ownerName is only carried when a
  // valid owner key is present.
  if (typeof obj.o === 'string' && HEX64.test(obj.o)) {
    out.owner = obj.o.toLowerCase()
    if (typeof obj.d === 'string' && obj.d.length > 0) {
      out.ownerName = obj.d.slice(0, NAME_MAX)
    }
  }
  // Optional space creator (c = creator profile public key): the root the membership
  // fold (an OR-Set) seeds from. Distinct from `owner` (the inviter, which can be any
  // member) — the creator is the single peer with no approval record, so every peer
  // must agree on it or honest member views diverge. Non-secret (a public key);
  // unauthenticated until a handshake identity binding confirms it (same status as
  // `owner`).
  if (typeof obj.c === 'string' && HEX64.test(obj.c)) out.creator = obj.c.toLowerCase()
  // Non-secret membership hints: schema version, auto-admit flag, per-link invite nonce, and the
  // link's expiry (epoch ms, a joiner-side hint — the minting member's record is authoritative).
  // None of these is a capability — the content key is never in the invite.
  if (Number.isInteger(obj.s) && obj.s >= 1 && obj.s <= SCHEMA_MAX) out.schemaVersion = obj.s
  if (obj.a === 1) out.autoAdmit = true
  if (typeof obj.id === 'string' && HEX32.test(obj.id)) out.inviteId = obj.id.toLowerCase()
  if (Number.isInteger(obj.x) && obj.x > 0) out.expiresAt = obj.x
  return out
}

export function encodeInvite({ topic, name, owner, ownerName, creator, schemaVersion, autoAdmit, inviteId, expiresAt }) {
  if (typeof topic !== 'string' || !HEX64.test(topic)) {
    throw new Error('encodeInvite: topic must be 64-char hex')
  }
  const obj = { v: 1, t: topic.toLowerCase() }
  if (typeof name === 'string' && name.length > 0) {
    obj.n = name.slice(0, NAME_MAX)
  }
  if (typeof owner === 'string' && HEX64.test(owner)) {
    obj.o = owner.toLowerCase()
    if (typeof ownerName === 'string' && ownerName.length > 0) {
      obj.d = ownerName.slice(0, NAME_MAX)
    }
  }
  if (typeof creator === 'string' && HEX64.test(creator)) obj.c = creator.toLowerCase()
  if (Number.isInteger(schemaVersion) && schemaVersion >= 2) obj.s = schemaVersion
  if (autoAdmit) obj.a = 1
  if (typeof inviteId === 'string' && HEX32.test(inviteId)) obj.id = inviteId.toLowerCase()
  if (Number.isInteger(expiresAt) && expiresAt > 0) obj.x = expiresAt
  return b64urlEncode(JSON.stringify(obj))
}

export { HEX64, B64URL, NAME_MAX }
