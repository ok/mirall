// A local stand-in for the Console's config-bundles endpoint, on http://127.0.0.1 (the app accepts
// it only behind the loopback lever). `set` replaces what it serves; every request is recorded.
import http from 'bare-http1'
import b4a from 'b4a'

export async function startManagedConsole(t) {
  let served = { status: 200, bundles: [] }
  const requests = []
  const server = http.createServer((req, res) => {
    requests.push(req.url)
    const { status, bundles, delayMs = 0 } = served
    setTimeout(() => {
      if (status !== 200) {
        res.statusCode = status
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ error: 'x' }))
        return
      }
      const body = JSON.stringify({ bundles: bundles.map(({ profileId, bytes }) => ({ profileId, issuedAt: 0, bytes: b4a.toString(bytes, 'base64') })) })
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('ETag', '"' + body.length + '"')
      res.end(body)
    }, delayMs)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  t.teardown(() => new Promise((resolve) => server.close(resolve)))
  return {
    apiUrl: `http://127.0.0.1:${port}`,
    requests,
    set: (next) => { served = { status: 200, bundles: [], ...next } },
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}
