// Invite-code codec: v0 bare hex topics and v1 base64url JSON envelopes (space name, inviter, expiry), plus mirall://join link peeling.
export const NAME_MAX = 80
const HEX64 = /^[0-9a-f]{64}$/i
const B64URL = /^[A-Za-z0-9_-]+$/

function positiveInt(n: number | undefined): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n > 0
}

export type DecodedInvite =
  | { v: 0; topic: string }
  | { v: 1; topic: string; name?: string; owner?: string; ownerName?: string; expiresAt?: number }

interface InviteEnvelopeShape {
  v?: number
  t?: string
  n?: string
  o?: string
  d?: string
  x?: number
}

function b64urlEncode(str: string): string {
  const bytes = new TextEncoder().encode(str)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlDecode(s: string): string {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  const std = s.replace(/-/g, '+').replace(/_/g, '/') + pad
  const bin = atob(std)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder('utf-8').decode(bytes)
}

// Reduce a pasted value to the bare invite code. A mirall://join deep link
// (path form mirall://join/<code> or query form mirall://join?code=<code>) is
// peeled down to <code>; anything else passes through trimmed and unchanged, so
// typing or pasting a raw code is never mangled. Mirrors src/main/deeplink.js so
// a pasted link resolves to the same code as clicking it.
export function extractInviteCode(input: string): string {
  if (typeof input !== 'string') return ''
  const trimmed = input.trim()
  let url: URL
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

export function decodeInvite(input: string): DecodedInvite | null {
  if (typeof input !== 'string') return null
  const cleaned = extractInviteCode(input)
  if (!cleaned) return null

  const stripped = cleaned.replace(/-/g, '').toLowerCase()
  if (HEX64.test(stripped)) return { v: 0, topic: stripped }

  if (!B64URL.test(cleaned)) return null
  let obj: InviteEnvelopeShape | null = null
  try {
    const parsed = JSON.parse(b64urlDecode(cleaned)) as InviteEnvelopeShape | null
    obj = parsed
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  if (obj.v !== 1) return null
  if (typeof obj.t !== 'string' || !HEX64.test(obj.t)) return null

  const out: DecodedInvite = { v: 1, topic: obj.t.toLowerCase() }
  if (typeof obj.n === 'string' && obj.n.length > 0) {
    out.name = obj.n.slice(0, NAME_MAX)
  }
  // Optional inviter identity — see shared/invite-envelope.js for the rationale.
  // Kept in sync with the worker decoder.
  if (typeof obj.o === 'string' && HEX64.test(obj.o)) {
    out.owner = obj.o.toLowerCase()
    if (typeof obj.d === 'string' && obj.d.length > 0) {
      out.ownerName = obj.d.slice(0, NAME_MAX)
    }
  }
  if (positiveInt(obj.x)) out.expiresAt = obj.x
  return out
}

export function encodeInvite(
  { topic, name, owner, ownerName }: { topic: string; name?: string; owner?: string; ownerName?: string },
): string {
  if (typeof topic !== 'string' || !HEX64.test(topic)) {
    throw new Error('encodeInvite: topic must be 64-char hex')
  }
  const obj: InviteEnvelopeShape = { v: 1, t: topic.toLowerCase() }
  if (typeof name === 'string' && name.length > 0) {
    obj.n = name.slice(0, NAME_MAX)
  }
  if (typeof owner === 'string' && HEX64.test(owner)) {
    obj.o = owner.toLowerCase()
    if (typeof ownerName === 'string' && ownerName.length > 0) {
      obj.d = ownerName.slice(0, NAME_MAX)
    }
  }
  return b64urlEncode(JSON.stringify(obj))
}
