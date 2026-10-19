// The activation code an organization hands out as <links-base>/license#a/<code>, which the landing
// page passes to the app as mirall://license/a/<code>. It is unsigned: the app trusts only the bundle
// it then fetches, which is signed and bound to this drive key. The Console's
// activation-link-v1.json pins the layout: version · licenseKey(15) · driveKey(32) · apiUrl, then
// the first 4 bytes of unkeyed BLAKE2b-256 over that body, all in z-base-32.
import c from 'compact-encoding'
import b4a from 'b4a'
import z32 from 'z32'
import crypto from 'hypercore-crypto'
import { MAX_CODE_CHARS } from '../contract/activation-syntax.js'

const VERSION = 1
const CHECKSUM_BYTES = 4
const licenseKey = c.fixed(15)

const body = {
  preencode(state, v) {
    c.uint.preencode(state, v.version)
    licenseKey.preencode(state, v.licenseKey)
    c.fixed32.preencode(state, v.driveKey)
    c.string.preencode(state, v.apiUrl)
  },
  encode(state, v) {
    c.uint.encode(state, v.version)
    licenseKey.encode(state, v.licenseKey)
    c.fixed32.encode(state, v.driveKey)
    c.string.encode(state, v.apiUrl)
  },
  decode(state) {
    return { version: c.uint.decode(state), licenseKey: licenseKey.decode(state), driveKey: c.fixed32.decode(state), apiUrl: c.string.decode(state) }
  },
}

const checksum = (payload) => crypto.hash(payload).subarray(0, CHECKSUM_BYTES)

export function decodeActivationCode(code, { allowHttp = false } = {}) {
  if (typeof code !== 'string' || code.length === 0 || code.length > MAX_CODE_CHARS) return null
  let bytes
  try {
    bytes = z32.decode(code.trim().toLowerCase())
  } catch {
    return null
  }
  if (bytes.byteLength <= CHECKSUM_BYTES) return null
  const payload = bytes.subarray(0, bytes.byteLength - CHECKSUM_BYTES)
  if (!b4a.equals(checksum(payload), bytes.subarray(bytes.byteLength - CHECKSUM_BYTES))) return null
  let decoded
  try {
    const state = c.state(0, payload.byteLength, payload)
    decoded = body.decode(state)
    if (state.start !== state.end) return null
  } catch {
    return null
  }
  if (decoded.version !== VERSION || !apiUrlOk(decoded.apiUrl, { allowHttp })) return null
  return { licenseKey: b4a.from(decoded.licenseKey), driveKey: b4a.from(decoded.driveKey), apiUrl: decoded.apiUrl }
}

// The Console's checkApiUrl: https, no credentials, query or fragment, path exactly "/" with no
// trailing slash, never a supabase.co host. http://127.0.0.1 only behind the test lever.
export function apiUrlOk(s, { allowHttp = false } = {}) {
  if (typeof s !== 'string' || s.endsWith('/')) return false
  let url
  try {
    url = new URL(s)
  } catch {
    return false
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return false
  const loopback = allowHttp && url.protocol === 'http:' && url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !loopback) return false
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  return host !== 'supabase.co' && !host.endsWith('.supabase.co')
}

/** @internal tests; the Console encodes the real codes */
export function encodeActivationCode({ licenseKey: key, driveKey, apiUrl }) {
  const payload = c.encode(body, { version: VERSION, licenseKey: key, driveKey, apiUrl })
  return z32.encode(b4a.concat([payload, checksum(payload)]))
}
