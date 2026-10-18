// The signed document's rules (the Console's packages/core/publication/document.ts): the
// organization and the endpoints are required, and any invalid field makes the whole document
// malformed. The hash covers the bytes as received, so nothing here re-serializes.
import b4a from 'b4a'
import { apiUrlOk } from './activation-link.js'

const NAME_MAX = 80
const SUPPORT_URL_MAX = 300
const SUPPORT_EMAIL_MAX = 254

const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

function supportUrl(input) {
  if (typeof input !== 'string' || input.length > SUPPORT_URL_MAX) return null
  try {
    const url = new URL(input)
    return url.protocol === 'https:' && !url.username && !url.password ? input : null
  } catch {
    return null
  }
}

const supportEmail = (input) => typeof input === 'string' && input.length <= SUPPORT_EMAIL_MAX && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input) ? input : null

export function checkOrganization(input) {
  if (!isRecord(input) || typeof input.name !== 'string') return null
  const name = input.name
  if (name !== name.normalize('NFC') || name !== name.trim() || name.length === 0 || [...name].length > NAME_MAX) return null
  const url = input.supportUrl === undefined ? undefined : supportUrl(input.supportUrl)
  const email = input.supportEmail === undefined ? undefined : supportEmail(input.supportEmail)
  if (url === null || email === null) return null
  return { name, supportUrl: url ?? null, supportEmail: email ?? null }
}

export function parseDocument(plaintext, { allowHttp = false } = {}) {
  // Invalid UTF-8 is refused, not repaired: a replacement character would not re-encode to the bytes
  // the hash covered.
  const text = b4a.toString(plaintext, 'utf8')
  if (!b4a.equals(b4a.from(text, 'utf8'), plaintext)) return null
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(parsed) || !isRecord(parsed.settings)) return null
  for (const value of Object.values(parsed.settings)) {
    if (!isRecord(value) || !('value' in value)) return null
  }
  const organization = checkOrganization(parsed.organization)
  const apiUrl = isRecord(parsed.endpoints) ? parsed.endpoints.apiUrl : undefined
  if (!organization || !apiUrlOk(apiUrl, { allowHttp })) return null
  return { organization, endpoints: { apiUrl }, settings: parsed.settings }
}
