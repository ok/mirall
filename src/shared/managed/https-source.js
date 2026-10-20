// The Console's copy of a drive's bundles, behind the API gateway: the preview's only source, and
// the fallback while no drive peer is connected. Never throws; every outcome is a kind.
import b4a from 'b4a'
import { header, request } from './console-request.js'

const MAX_BUNDLE_BYTES = 1024 * 1024
const RETRY_MS = 60_000

function parseBundles(body) {
  const parsed = JSON.parse(b4a.toString(body))
  if (!Array.isArray(parsed?.bundles)) return null
  const out = []
  for (const b of parsed.bundles) {
    if (typeof b?.profileId !== 'string' || typeof b.bytes !== 'string') return null
    const bytes = b4a.from(b.bytes, 'base64')
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_BUNDLE_BYTES) return null
    out.push({ profileId: b.profileId, bytes })
  }
  return out
}

// One GET of config-bundles for this drive and key hint. The kinds: 'bundles' (possibly empty),
// 'unchanged' (304), 'org-unavailable' (404: unknown, suspended or deleted), 'retry' (with afterMs),
// 'error' (a request this build should never send).
export async function fetchBundles({ apiUrl, driveKey, hint, etag = null, timers, timeoutMs = 15_000 }) {
  let url
  try {
    url = new URL(`/functions/v1/config-bundles/${b4a.toString(driveKey, 'hex')}?hint=${b4a.toString(hint, 'hex')}`, apiUrl)
  } catch {
    return { kind: 'error', detail: 'apiUrl' }
  }
  const res = await request(url, { headers: etag ? { 'If-None-Match': etag } : {} }, { timers, timeoutMs })
  if (res.error) return { kind: 'retry', afterMs: RETRY_MS, detail: res.error }
  if (res.status === 304) return { kind: 'unchanged', etag }
  if (res.status === 404) return { kind: 'org-unavailable' }
  if (res.status === 429) return { kind: 'retry', afterMs: (Number(header(res.headers, 'retry-after')) || 60) * 1000, detail: 'rate_limited' }
  if (res.status === 400) return { kind: 'error', detail: b4a.toString(res.body).slice(0, 200) }
  if (res.status !== 200) return { kind: 'retry', afterMs: RETRY_MS, detail: `status ${res.status}` }
  try {
    const bundles = parseBundles(res.body)
    return bundles ? { kind: 'bundles', etag: header(res.headers, 'etag'), bundles } : { kind: 'retry', afterMs: RETRY_MS, detail: 'malformed' }
  } catch {
    return { kind: 'retry', afterMs: RETRY_MS, detail: 'malformed' }
  }
}
