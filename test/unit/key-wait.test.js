import test from 'brittle'
import { createKeyWait } from '../../src/worker/key-wait.js'
import { AppError } from '../../src/shared/core/errors.js'
import { CODES } from '../../src/shared/contract/errors.js'

const KEY = { kek: 'ab'.repeat(32), relaySeed: null }
const wrong = () => Promise.reject(new AppError(CODES.IDENTITY_UNLOCK_FAILED, 'identity unlock failed'))

test('a worker handed its key by a host refuses every unlock', async (t) => {
  let boots = 0
  const wait = createKeyWait({ awaiting: false, boot: async () => { boots++ } })
  t.absent(wait.awaiting)
  await t.exception(wait.unlock(KEY), /not waiting for a key/)
  t.is(boots, 0, 'and boots nothing')
})

test('a good key boots once, settles the wait with the root, and closes it', async (t) => {
  const seen = []
  const wait = createKeyWait({ awaiting: true, boot: async (key) => { seen.push(key); return { root: 1 } } })
  t.ok(wait.awaiting)
  await wait.unlock(KEY)
  t.alike(await wait.booted, { root: 1 })
  t.alike(seen, [KEY], 'the boot gets the key it was handed')
  t.absent(wait.awaiting)
  try {
    await wait.unlock(KEY)
    t.fail('a second unlock was accepted')
  } catch (err) {
    t.is(err.code, CODES.NOT_AUTHORIZED, 'a second unlock is refused, never a second boot')
  }
  t.is(seen.length, 1)
})

test('a key that cannot open the identity leaves the worker waiting for another', async (t) => {
  let n = 0
  const wait = createKeyWait({ awaiting: true, boot: () => (++n === 1 ? wrong() : Promise.resolve('root')) })
  await t.exception(wait.unlock(KEY), /identity unlock failed/)
  t.ok(wait.awaiting, 'still waiting')
  await wait.unlock(KEY)
  t.is(await wait.booted, 'root')
})

test('concurrent unlocks run one at a time, the second against what the first left', async (t) => {
  let running = 0
  let most = 0
  const wait = createKeyWait({
    awaiting: true,
    boot: async () => {
      running++
      most = Math.max(most, running)
      await new Promise((resolve) => setTimeout(resolve, 20))
      running--
      return 'root'
    },
  })
  const [first, second] = await Promise.allSettled([wait.unlock(KEY), wait.unlock(KEY)])
  t.is(most, 1, 'never two boots at once')
  t.is(first.status, 'fulfilled')
  t.is(second.status, 'rejected')
  t.is(second.reason.code, CODES.NOT_AUTHORIZED, 'the second sees the first booted')
})

test('a boot that fails for any other reason ends the wait with that failure', async (t) => {
  const fault = Object.assign(new Error('disk on fire'), { code: 'EIO' })
  const wait = createKeyWait({ awaiting: true, boot: () => Promise.reject(fault) })
  await t.exception(wait.unlock(KEY), /disk on fire/)
  await t.exception(wait.booted, /disk on fire/, 'the entry sees the boot fail, as it would a spawned one')
  t.absent(wait.awaiting)
})
