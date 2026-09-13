// User feedback to support. The caption carries the context a report is useless without — who,
// which build, which platform, when — and is truncated to whatever room the transport leaves.

import os from 'bare-os'
import { getProfile } from '../../shared/spaces/profile.js'
import { getRuntimeConfig } from '../../shared/core/runtime-config.js'
import { sendFeedback } from '../../shared/telemetry/feedback.js'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function formatTimestamp(d) {
  const pad = (n) => String(n).padStart(2, '0')
  const offsetMin = -d.getTimezoneOffset()
  const sign = offsetMin >= 0 ? '+' : '-'
  const absMin = Math.abs(offsetMin)
  const offH = Math.floor(absMin / 60)
  const offM = absMin % 60
  const offset = offM === 0 ? `UTC${sign}${offH}` : `UTC${sign}${offH}:${pad(offM)}`
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} at ${pad(d.getHours())}:${pad(d.getMinutes())} (${offset})`
}

export function registerFeedback(ipc) {
  ipc.handle('feedback:send', async (msg) => {
    const profile = await getProfile()
    const displayName = profile?.displayName || 'Unknown User'
    const email = typeof msg.email === 'string' && msg.email.trim() ? msg.email.trim() : null
    const timestamp = formatTimestamp(new Date())
    const cfg = getRuntimeConfig()
    const appVersion = cfg.appVersion || (cfg.dev ? 'dev' : 'unknown')
    const comment = msg.comment || '(no comment)'

    const headerLines = [`Feedback from ${displayName}`]
    if (email) headerLines.push(email)
    headerLines.push(`v${appVersion} · ${os.platform()} ${os.release()} (${os.arch()})`)
    headerLines.push(timestamp)
    const header = headerLines.join('\n') + '\n\n'

    // A screenshot rides in the same caption, against a far smaller limit.
    const captionLimit = msg.screenshot ? 1024 : 4096
    const room = captionLimit - header.length
    const finalComment = comment.length > room ? comment.slice(0, room - 3) + '...' : comment
    const caption = header + finalComment

    const screenshotBuffer = msg.screenshot
      ? Buffer.from(msg.screenshot, 'base64')
      : null

    await sendFeedback(caption, screenshotBuffer)
    return { ok: true }
  })
}
