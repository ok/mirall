// One signed POST of the upward plane, POST <apiUrl>/v1/<call>. Never throws: the answer is its
// status with the Console's error code, or status 0 when nothing came back.
import b4a from 'b4a'
import { header, request } from './console-request.js'

const MAX_ANSWER_BYTES = 64 * 1024

function parseAnswer(body) {
  try {
    const parsed = JSON.parse(b4a.toString(body))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export async function postUpward({ apiUrl, call, headers, body, timers, timeoutMs }) {
  let url
  try {
    url = new URL(`/v1/${call}`, apiUrl)
  } catch {
    return { status: 0, error: 'apiUrl' }
  }
  const res = await request(url, { method: 'POST', headers: { ...headers, 'content-length': String(body.byteLength) }, body }, { timers, timeoutMs, maxBytes: MAX_ANSWER_BYTES })
  if (res.error) return { status: 0, error: res.error }
  const answer = parseAnswer(res.body)
  const retryAfter = Number(header(res.headers, 'retry-after'))
  return {
    status: res.status,
    error: typeof answer.error === 'string' ? answer.error : null,
    serverTime: Number.isInteger(answer.serverTime) ? answer.serverTime : null,
    retryAfterMs: retryAfter > 0 ? retryAfter * 1000 : null,
  }
}
