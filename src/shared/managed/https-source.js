// The Console's copy of a drive's bundles, behind the API gateway: the preview's only source, and
// the fallback while no drive peer is connected. Never throws; every outcome is a kind.
import https from 'bare-https'
import http from 'bare-http1'
import b4a from 'b4a'

const MAX_BODY_BYTES = 16 * 1024 * 1024
const MAX_BUNDLE_BYTES = 1024 * 1024
const RETRY_MS = 60_000

function request(url, headers, { timers, timeoutMs }) {
  return new Promise((resolve) => {
    const lib = url.protocol === 'http:' ? http : https
    let done = false
    let req = null
    const finish = (value) => {
      if (done) return
      done = true
      timers.clear(deadline)
      resolve(value)
    }
    const deadline = timers.setTimeout(() => {
      try { req?.destroy() } catch {}
      finish({ error: 'timeout' })
    }, timeoutMs)
    try {
      req = lib.request({ hostname: url.hostname, port: url.port ? Number(url.port) : undefined, path: url.pathname + url.search, method: 'GET', headers }, (res) => {
        const chunks = []
        let size = 0
        res.on('data', (chunk) => {
          size += chunk.byteLength
          if (size > MAX_BODY_BYTES) {
            try { req.destroy() } catch {}
            finish({ error: 'too_large' })
          } else chunks.push(chunk)
        })
        res.on('end', () => finish({ status: res.statusCode, headers: res.headers, body: b4a.concat(chunks) }))
        res.on('error', () => finish({ error: 'network' }))
      })
      req.on('error', () => finish({ error: 'network' }))
      req.end()
    } catch {
      finish({ error: 'network' })
    }
  })
}

const header = (headers, name) => {
  for (const [key, value] of Object.entries(headers ?? {})) if (key.toLowerCase() === name) return String(value)
  return null
}

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
  const res = await request(url, etag ? { 'If-None-Match': etag } : {}, { timers, timeoutMs })
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
