// One request to the Console behind the API gateway, over HTTPS (plain HTTP only to the loopback test
// server). Never throws: the result is { status, headers, body } or { error }.
import https from 'bare-https'
import http from 'bare-http1'
import b4a from 'b4a'

const MAX_BODY_BYTES = 16 * 1024 * 1024

export function request(url, { method = 'GET', headers = {}, body = null }, { timers, timeoutMs, maxBytes = MAX_BODY_BYTES }) {
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
      req = lib.request({ hostname: url.hostname, port: url.port ? Number(url.port) : undefined, path: url.pathname + url.search, method, headers }, (res) => {
        const chunks = []
        let size = 0
        res.on('data', (chunk) => {
          size += chunk.byteLength
          if (size > maxBytes) {
            try { req.destroy() } catch {}
            finish({ error: 'too_large' })
          } else chunks.push(chunk)
        })
        res.on('end', () => finish({ status: res.statusCode, headers: res.headers, body: b4a.concat(chunks) }))
        res.on('error', () => finish({ error: 'network' }))
      })
      req.on('error', () => finish({ error: 'network' }))
      if (body) req.end(body)
      else req.end()
    } catch {
      finish({ error: 'network' })
    }
  })
}

export const header = (headers, name) => {
  for (const [key, value] of Object.entries(headers ?? {})) if (key.toLowerCase() === name) return String(value)
  return null
}
