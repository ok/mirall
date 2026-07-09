// User-initiated feedback: POSTs the message + optional screenshot to the feedback
// relay as multipart/form-data, tagged with install id, app version, and release
// channel. Only runs when the user submits the feedback form — nothing is sent
// automatically.
import https from 'bare-https'
import b4a from 'b4a'
import { getRuntimeConfig } from '../core/runtime-config.js'
import { getInstallId } from './install-id.js'
import { createLogger } from '../core/logger.js'
import { deriveChannel } from '../core/channel.js'

const log = createLogger('feedback')

// Relay endpoint. Not a secret — the bot token lives in the Cloudflare
// Worker's secrets. The relay routes to the right Telegram chat from the
// x-mirall-channel header.
const RELAY_HOST = 'feedback.mirall.app'
const RELAY_PORT = 443
const RELAY_PATH = '/feedback'

function buildMultipart (fields, file) {
  const boundary = '----MirallFeedback' + Date.now()
  const parts = []

  for (const [key, value] of Object.entries(fields)) {
    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${key}"\r\n\r\n` +
      `${value}\r\n`
    )
  }

  if (file) {
    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="photo"; filename="screenshot.png"\r\n` +
      `Content-Type: image/png\r\n\r\n`
    )
  }

  const textParts = b4a.from(parts.join(''), 'utf-8')
  const closing = b4a.from(`\r\n--${boundary}--\r\n`, 'utf-8')

  let body
  if (file) {
    body = b4a.concat([textParts, file, closing])
  } else {
    body = b4a.concat([textParts, closing])
  }

  return { body, boundary }
}

function httpsPost (body, headers) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Feedback relay request timed out')), 15000)

    const req = https.request({
      hostname: RELAY_HOST,
      port: RELAY_PORT,
      path: RELAY_PATH,
      method: 'POST',
      headers
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        clearTimeout(timer)
        const text = b4a.concat(chunks).toString('utf-8')
        resolve({ status: res.statusCode, text })
      })
      res.on('error', (err) => { clearTimeout(timer); reject(err) })
    })

    req.on('error', (err) => { clearTimeout(timer); reject(err) })
    req.end(body)
  })
}

export async function sendFeedback (caption, screenshotBuffer) {
  const cfg = getRuntimeConfig()
  if (!cfg.storage) throw new Error('Feedback unavailable: storage path not configured')

  const installId = await getInstallId(cfg.storage)
  const channel = deriveChannel(cfg)

  const fields = { caption }
  const { body, boundary } = buildMultipart(fields, screenshotBuffer || null)

  const headers = {
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
    'Content-Length': body.length,
    'x-mirall-install-id': installId,
    'x-mirall-version': cfg.appVersion || 'unknown',
    'x-mirall-channel': channel
  }

  log.info('POST', `${RELAY_HOST}${RELAY_PATH}`, 'channel=' + channel, 'bytes=' + body.length, 'install=' + installId.slice(0, 8))

  let response
  try {
    response = await httpsPost(body, headers)
  } catch (err) {
    log.warn('relay request failed:', err.message)
    throw err
  }

  const { status, text } = response
  log.info('relay status', status, 'body=' + (text ? text.slice(0, 200) : '(empty)'))

  if (status === 429) throw new Error('rate_limited')
  if (status < 200 || status >= 300) {
    let message = 'Feedback relay error'
    try {
      const parsed = JSON.parse(text)
      if (parsed && parsed.error) message = parsed.error
    } catch {}
    throw new Error(message)
  }

  return { ok: true }
}
