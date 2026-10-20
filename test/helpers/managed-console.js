// A local stand-in for the Console behind the gateway, on http://127.0.0.1 (the app accepts it only
// behind the loopback lever): config-bundles, and the upward calls, whose signatures it checks the
// way the Console does. `set` replaces the bundles it serves, `answer` the upward reply; bundle
// requests and upward calls are recorded apart.
import http from 'bare-http1'
import b4a from 'b4a'
import sodium from 'sodium-native'
import { enrollmentMessage, requestMessage } from '../../src/shared/managed/upward.js'

const UPWARD = /^\/v1\/(instance-enroll|instance-report)$/

function verifyUpward(call, headers, body) {
  const instanceKey = b4a.from(headers['x-mirall-instance-key'] ?? '', 'hex')
  const nonce = b4a.from(headers['x-mirall-nonce'] ?? '', 'hex')
  const timestamp = Number(headers['x-mirall-timestamp'])
  const signature = b4a.from(headers['x-mirall-signature'] ?? '', 'hex')
  if (instanceKey.byteLength !== 32 || nonce.byteLength !== 16 || signature.byteLength !== 64 || !Number.isSafeInteger(timestamp)) return { signed: false }
  const signed = sodium.crypto_sign_verify_detached(signature, requestMessage({ call, instanceKey, timestamp, nonce, body }), instanceKey)
  const parsed = JSON.parse(b4a.toString(body))
  let enrolled = null
  if (call === 'instance-enroll') {
    const message = enrollmentMessage({ instanceKey, timestamp, nonce })
    enrolled = sodium.crypto_sign_verify_detached(b4a.from(parsed.enrollSignature, 'hex'), message, b4a.from(parsed.enrollPublicKey, 'hex'))
  }
  return { signed, enrolled, instanceKey: b4a.toString(instanceKey, 'hex'), timestamp, nonce: b4a.toString(nonce, 'hex'), body: parsed }
}

function reply(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

export async function startManagedConsole(t) {
  let served = { status: 200, bundles: [] }
  let answer = () => ({ status: 200, body: {} })
  const requests = []
  const upward = []
  const server = http.createServer((req, res) => {
    const call = req.method === 'POST' ? UPWARD.exec(req.url)?.[1] : null
    if (!call) requests.push(req.url)
    if (call) {
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        const entry = { call, ...verifyUpward(call, req.headers, b4a.concat(chunks)) }
        upward.push(entry)
        const { status, body } = answer(entry)
        reply(res, status, body)
      })
      return
    }
    const { status, bundles, delayMs = 0 } = served
    setTimeout(() => {
      if (status !== 200) {
        reply(res, status, { error: 'x' })
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
    upward,
    set: (next) => { served = { status: 200, bundles: [], ...next } },
    answer: (next) => { answer = next },
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}
