// How a worker comes to hold its key and open its identity. It starts waiting: identity:unlock hands
// a key over, and `open` applies any pending identity change and boots the data layer with it. A key
// that cannot open the identity locks the worker with that code and is kept, because it is the key a
// recovery seals the identity under; another unlock may replace it. While locked, a recovery action
// runs and then opens the identity again with the held key, in the same process. Attempts and
// recoveries run one at a time, each against the state the one before it left; once the identity is
// open nothing runs again.
import { AppError } from '../shared/core/errors.js'
import { CODES, isIdentityLock } from '../shared/contract/errors.js'

/** @import { IdentityLockCode } from '../shared/contract/errors.js' */
/** @typedef {{ kek: string, relaySeed: string | null }} HandedKey */
/**
 * What a recovery hands back: the reply its request answers with, and whether it changed what the
 * held key would open, so the identity is opened again before the reply goes out.
 * @template R
 * @typedef {{ reply: R, reopen: boolean }} Recovered
 */
/**
 * @typedef {<R>(action: () => Promise<Recovered<R>> | Recovered<R>, refusal: string) => Promise<R>} Recover
 */

/** @param {unknown} err */
const isLockCode = (err) => isIdentityLock(/** @type {{ code?: unknown } | null} */ (err)?.code)

/**
 * @template T
 * @param {{ open: (key: HandedKey) => Promise<T> }} deps
 */
export function createKeyWait({ open }) {
  /** @type {'awaiting' | 'locked' | 'open' | 'failed'} */
  let state = 'awaiting'
  /** @type {IdentityLockCode | null} */
  let code = CODES.IDENTITY_AWAITING_KEY
  /** @type {HandedKey | null} */
  let held = null
  let turn = Promise.resolve()
  /** @type {(root: T) => void} */
  let resolveBooted = () => {}
  /** @type {(err: unknown) => void} */
  let rejectBooted = () => {}
  /** @type {Promise<T>} */
  const booted = new Promise((resolve, reject) => { resolveBooted = resolve; rejectBooted = reject })
  booted.catch(() => {})

  /** @template R @param {() => Promise<R>} fn @returns {Promise<R>} */
  function inTurn(fn) {
    const run = turn.then(fn)
    turn = run.then(() => {}, () => {})
    return run
  }

  // Anything but a key that cannot open the identity is the boot's own failure, and ends the worker's
  // chance to open it the way a failed boot always has.
  async function openHeld() {
    try {
      const root = await open(/** @type {HandedKey} */ (held))
      state = 'open'
      code = null
      resolveBooted(root)
    } catch (err) {
      if (isLockCode(err)) {
        state = 'locked'
        code = /** @type {{ code: IdentityLockCode }} */ (err).code
      } else {
        state = 'failed'
        rejectBooted(err)
      }
      throw err
    }
  }

  /** @param {HandedKey} key */
  async function attempt(key) {
    if (state !== 'awaiting' && state !== 'locked') throw new AppError(CODES.NOT_AUTHORIZED, 'this worker is not waiting for a key')
    held = key
    await openHeld()
  }

  /** @type {Recover} */
  async function recovery(action, refusal) {
    if (state !== 'locked') throw new AppError(CODES.NOT_AUTHORIZED, refusal)
    const { reply, reopen } = await action()
    if (reopen) await openHeld()
    return reply
  }

  return {
    /** Why the identity is not open: waiting for a key, the code the held key failed with, or null once open. */
    get code() { return code },
    /** The key the last attempt handed over, which a recovery seals under. */
    get key() { return held },
    /** Settles with the root once the identity opens, or with the boot failure that ends the chance. */
    booted,
    /** @param {HandedKey} key @returns {Promise<void>} */
    unlock: (key) => inTurn(() => attempt(key)),
    /** @type {Recover} */
    recover: (action, refusal) => inTurn(() => recovery(action, refusal)),
  }
}
