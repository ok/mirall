// A worker started without a host has no key on its bootstrap, so it waits for one: identity:unlock
// hands it over, and `boot` runs the same boot a spawned worker runs with the key it was sent.
// Attempts run one at a time, each against the state the one before it left. A key that cannot open
// the identity leaves the worker waiting for another; once a boot succeeds, it is never run again.
// A worker that was handed its key by a host never waits, and refuses every attempt.
import { AppError } from '../shared/core/errors.js'
import { CODES, IDENTITY_LOCK_CODES } from '../shared/contract/errors.js'

/** @typedef {{ kek: string, relaySeed: string | null }} HandedKey */

/**
 * @template T
 * @param {{ awaiting: boolean, boot: (key: HandedKey) => Promise<T> }} deps
 */
export function createKeyWait({ awaiting, boot }) {
  /** @type {'awaiting' | 'booted' | 'failed' | 'closed'} */
  let state = awaiting ? 'awaiting' : 'closed'
  let turn = Promise.resolve()
  /** @type {(root: T) => void} */
  let resolveBooted = () => {}
  /** @type {(err: Error) => void} */
  let rejectBooted = () => {}
  /** @type {Promise<T>} */
  const booted = new Promise((resolve, reject) => { resolveBooted = resolve; rejectBooted = reject })
  booted.catch(() => {})

  /** @param {HandedKey} key */
  async function attempt(key) {
    if (state !== 'awaiting') throw new AppError(CODES.NOT_AUTHORIZED, 'this worker is not waiting for a key')
    try {
      const root = await boot(key)
      state = 'booted'
      resolveBooted(root)
    } catch (err) {
      // Anything but a key that cannot open the identity is the boot's own failure, and ends the
      // wait the way it ends a spawned worker's boot.
      if (!IDENTITY_LOCK_CODES.some((code) => code === err?.code)) {
        state = 'failed'
        rejectBooted(err)
      }
      throw err
    }
  }

  return {
    get awaiting() { return state === 'awaiting' },
    /** Settles with the root the first good key booted. */
    booted,
    /** @param {HandedKey} key @returns {Promise<void>} */
    unlock(key) {
      const run = turn.then(() => attempt(key))
      turn = run.catch(() => {})
      return run
    },
  }
}
