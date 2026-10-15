// The client half of a reveal. The worker answers where the file is on ITS disk; this hands the
// answer to main's shell gate, which decides whether that disk is this one and whether the path is
// one the user chose. A refusal is a sentence, not a silent click: the gate's code rides on the
// rejection so useRunAction's toast reads the right one.
import { CODES } from '../../shared/contract/errors.js'

/** @import { RevealTarget } from '../../shared/contract/responses.js' */
/** @typedef {{ showInFolder: (target: RevealTarget) => Promise<{ ok: boolean, code?: string } | undefined> }} RevealBridge */

/** @param {RevealTarget} target @param {RevealBridge} [bridge] */
export async function revealOnClient(target, bridge = window.bridge) {
  const res = await bridge.showInFolder({ path: target.path, exists: target.exists, host: target.host })
  if (res?.ok === true) return
  const err = Object.assign(new Error('reveal refused: ' + target.path), {
    code: typeof res?.code === 'string' ? res.code : CODES.REVEAL_REFUSED,
  })
  throw err
}
