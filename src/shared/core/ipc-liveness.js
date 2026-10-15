// Per-connection liveness. A request deadline notices a slow handler; this notices a peer that is
// connected and no longer reading — a hung window, a stopped debugger, a half-open pipe. Any frame
// from a client proves it alive, so only a quiet one is asked, and one that stays quiet through the
// grace is detached, which aborts what it left in flight. The host is exempt: its liveness is the
// process's.
import { FRAME } from '../contract/ipc-frames.js'
/** @import { Client } from './ipc-client.js' */

/**
 * @param {{ lastSeenAt: number, probeSentAt: number | null, now: number, keepaliveMs: number, graceMs: number }} state
 * @returns {'ok' | 'probe' | 'reap'}
 */
export function livenessVerdict({ lastSeenAt, probeSentAt, now, keepaliveMs, graceMs }) {
  if (probeSentAt !== null) return now - probeSentAt >= graceMs ? 'reap' : 'ok'
  return now - lastSeenAt >= keepaliveMs ? 'probe' : 'ok'
}

/**
 * @param {{
 *   clients: { all(): Client[] },
 *   isExempt: (client: Client) => boolean,
 *   detach: (client: Client, reason: string) => void,
 *   now: () => number,
 * }} deps
 */
export function createLivenessWatch({ clients, isExempt, detach, now }) {
  /** @param {{ keepaliveMs: number, graceMs: number }} timing */
  return function sweepLiveness({ keepaliveMs, graceMs }) {
    const at = now()
    for (const client of clients.all()) {
      if (isExempt(client) || !client.hello) continue
      const verdict = livenessVerdict({ lastSeenAt: client.lastSeenAt, probeSentAt: client.probeSentAt, now: at, keepaliveMs, graceMs })
      if (verdict === 'probe') {
        client.probeSentAt = at
        client.write(JSON.stringify({ type: FRAME.KEEPALIVE }) + '\n')
      } else if (verdict === 'reap') {
        detach(client, 'liveness')
      }
    }
  }
}
