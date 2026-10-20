// A local stand-in for the Console for the frontend suite: one organization, one license, bundles
// sealed with a throwaway signing key that the instance pins through MIRALL_MANAGED_TEST_SIGNING_KEY.
// `serve` swaps what it hands out; `fail` makes it answer with an error status until `serve` is
// called again. Upward calls are recorded in `upward`; `revoke` answers them as a revoked license.
import http from 'node:http'
import b4a from 'b4a'
import { signer, organization, sealBundle } from '../helpers/managed-seal.js'

export async function startManagedConsole({ name = 'Acme Test GmbH', supportEmail = null, supportUrl = null } = {}) {
  const key = signer()
  let state = { status: 200, bundles: [] }
  const requests = []
  const upward = []
  let revoked = false
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.method === 'POST' && req.url.startsWith('/v1/')) {
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        const body = JSON.parse(b4a.toString(b4a.concat(chunks)))
        upward.push({ call: req.url.slice(4), report: body.report ?? body })
        res.statusCode = revoked ? 410 : 200
        res.end(JSON.stringify(revoked ? { error: 'revoked' } : {}))
      })
      return
    }
    requests.push(req.url)
    if (state.status !== 200) {
      res.statusCode = state.status
      res.end(JSON.stringify({ error: 'unavailable' }))
      return
    }
    res.end(JSON.stringify({ bundles: state.bundles.map((b) => ({ profileId: 'p1', issuedAt: 0, bytes: b4a.toString(b, 'base64') })) }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const apiUrl = `http://127.0.0.1:${server.address().port}`
  const org = organization({ apiUrl })
  const details = { name, ...(supportEmail ? { supportEmail } : {}), ...(supportUrl ? { supportUrl } : {}) }
  let issuedAt = Math.floor(Date.now() / 1000)
  return {
    link: `mirall://license/a/${org.code}`,
    requests,
    upward,
    env: {
      MIRALL_MANAGED_TEST_SIGNING_KEY: key.publicHex,
      MIRALL_MANAGED_ALLOW_HTTP_LOOPBACK: '1',
      MIRALL_MANAGED_PREVIEW_TIMEOUT_MS: '3000',
      MIRALL_MANAGED_DRIVE_GRACE_MS: '0',
      MIRALL_MANAGED_HTTPS_POLL_MS: '2000',
      MIRALL_MANAGED_REPORT_DELAY_MS: '0',
    },
    serve(settings) {
      issuedAt += 1
      state = { status: 200, bundles: [sealBundle({ signer: key, driveKey: org.driveKey, recipients: [org.bundlePublicKey], organization: details, apiUrl, settings, issuedAt })] }
    },
    fail(status = 503) { state = { status, bundles: [] } },
    revoke() { revoked = true },
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}
