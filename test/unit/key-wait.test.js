import test from 'brittle'
import { createKeyWait } from '../../src/worker/key-wait.js'
import { AppError } from '../../src/shared/core/errors.js'
import { CODES } from '../../src/shared/contract/errors.js'

const KEY = { kek: 'ab'.repeat(32), relaySeed: null }
const OTHER = { kek: 'cd'.repeat(32), relaySeed: 'ef'.repeat(32) }
const wrong = () => Promise.reject(new AppError(CODES.IDENTITY_UNLOCK_FAILED, 'identity unlock failed'))
const mismatch = () => Promise.reject(new AppError(CODES.IDENTITY_PROVIDER_MISMATCH, 'sealed by another provider'))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function codeOf(promise) {
  try {
    await promise
    return null
  } catch (err) {
    return err.code
  }
}

// A wait whose first attempt fails with the given lock, and whose later ones open.
function lockedWait(fail = wrong) {
  const seen = []
  const wait = createKeyWait({ open: (key) => { seen.push(key); return seen.length === 1 ? fail() : Promise.resolve('root') } })
  return { wait, seen }
}

test('a worker starts waiting, holding no key, and recovers nothing', async (t) => {
  let opens = 0
  const wait = createKeyWait({ open: async () => { opens++ } })
  t.is(wait.code, CODES.IDENTITY_AWAITING_KEY)
  t.is(wait.key, null)
  let ran = false
  t.is(await codeOf(wait.recover(() => { ran = true; return { reply: 1, reopen: true } }, 'not locked')), CODES.NOT_AUTHORIZED)
  t.absent(ran, 'the recovery never ran')
  t.is(opens, 0)
})

test('a good key opens once, settles the wait with the root, and closes it', async (t) => {
  const seen = []
  const wait = createKeyWait({ open: async (key) => { seen.push(key); return { root: 1 } } })
  await wait.unlock(KEY)
  t.alike(await wait.booted, { root: 1 })
  t.alike(seen, [KEY], 'the open gets the key it was handed')
  t.is(wait.code, null)
  t.alike(wait.key, KEY, 'and the key stays held for a later seal')
  t.is(await codeOf(wait.unlock(KEY)), CODES.NOT_AUTHORIZED, 'a second unlock is refused, never a second open')
  t.is(await codeOf(wait.recover(() => ({ reply: 1, reopen: true }), 'not locked')), CODES.NOT_AUTHORIZED, 'and so is a recovery')
  t.is(seen.length, 1)
})

test('a key that cannot open the identity locks with its code and is held', async (t) => {
  for (const [fail, code] of [[wrong, CODES.IDENTITY_UNLOCK_FAILED], [mismatch, CODES.IDENTITY_PROVIDER_MISMATCH]]) {
    const { wait } = lockedWait(fail)
    t.is(await codeOf(wait.unlock(KEY)), code)
    t.is(wait.code, code, 'the lock says why, not that it waits')
    t.alike(wait.key, KEY, 'the key it was given is kept to seal a recovery under')
  }
})

test('a retry replaces the held key, and the right one opens in place', async (t) => {
  const seen = []
  const wait = createKeyWait({ open: (key) => { seen.push(key); return seen.length < 3 ? wrong() : Promise.resolve('root') } })
  await t.exception(wait.unlock(KEY), /identity unlock failed/)
  await t.exception(wait.unlock(OTHER), /identity unlock failed/)
  t.alike(wait.key, OTHER, 'the newer key is held')
  await wait.unlock(KEY)
  t.is(await wait.booted, 'root')
  t.alike(seen, [KEY, OTHER, KEY], 'each attempt opens with its own key, relay seed included')
  t.is(wait.code, null)
})

test('a recovery on a locked worker runs, then opens the identity with the held key before it answers', async (t) => {
  const { wait, seen } = lockedWait()
  await t.exception(wait.unlock(KEY))
  const order = []
  const reply = await wait.recover(async () => {
    order.push('action')
    return { reply: { folder: '/aside' }, reopen: true }
  }, 'not locked')
  order.push('answered')
  t.alike(reply, { folder: '/aside' })
  t.is(await wait.booted, 'root')
  t.alike(seen, [KEY, KEY], 'opened again with the held key')
  t.alike(order, ['action', 'answered'])
  t.is(wait.code, null, 'open')
})

test('a recovery that changed nothing leaves the worker locked; one that failed leaves it as it was', async (t) => {
  const { wait, seen } = lockedWait()
  await t.exception(wait.unlock(KEY))
  t.alike(await wait.recover(() => ({ reply: { unlocked: false }, reopen: false }), 'not locked'), { unlocked: false })
  t.is(seen.length, 1, 'no second open')
  const failed = wait.recover(() => Promise.reject(new AppError(CODES.WRONG_PASSPHRASE, 'wrong passphrase')), 'not locked')
  t.is(await codeOf(failed), CODES.WRONG_PASSPHRASE)
  t.is(wait.code, CODES.IDENTITY_UNLOCK_FAILED, 'still locked, still saying why')
  t.alike(wait.key, KEY)
})

test('a recovery whose open fails on the key locks again with that code', async (t) => {
  const seen = []
  const wait = createKeyWait({ open: () => { seen.push(1); return seen.length === 1 ? wrong() : mismatch() } })
  await t.exception(wait.unlock(KEY))
  t.is(await codeOf(wait.recover(() => ({ reply: 1, reopen: true }), 'not locked')), CODES.IDENTITY_PROVIDER_MISMATCH)
  t.is(wait.code, CODES.IDENTITY_PROVIDER_MISMATCH)
})

test('attempts and recoveries run one at a time, each against what the one before left', async (t) => {
  let running = 0
  let most = 0
  let opens = 0
  const busy = async (result) => {
    running++
    most = Math.max(most, running)
    await sleep(20)
    running--
    return result
  }
  const wait = createKeyWait({ open: async () => (++opens === 1 ? busy().then(wrong) : busy('root')) })
  const first = wait.unlock(KEY)
  const recovery = wait.recover(() => busy({ reply: 'recovered', reopen: true }), 'not locked')
  const late = wait.unlock(OTHER)
  const lateRecovery = wait.recover(() => busy({ reply: 'again', reopen: true }), 'not locked')
  const [a, b, c, d] = await Promise.allSettled([first, recovery, late, lateRecovery])
  t.is(most, 1, 'never two at once')
  t.is(a.reason.code, CODES.IDENTITY_UNLOCK_FAILED, 'the first key locks')
  t.is(b.value, 'recovered', 'the recovery runs against that lock and opens the identity')
  t.is(c.reason.code, CODES.NOT_AUTHORIZED, 'the later key finds it open')
  t.is(d.reason.code, CODES.NOT_AUTHORIZED, 'and so does the later recovery')
  t.is(opens, 2)
})

test('an open that fails for any other reason ends the wait with that failure', async (t) => {
  const fault = Object.assign(new Error('disk on fire'), { code: 'EIO' })
  const wait = createKeyWait({ open: () => Promise.reject(fault) })
  await t.exception(wait.unlock(KEY), /disk on fire/)
  await t.exception(wait.booted, /disk on fire/, 'the entry sees the boot fail, as it would a spawned one')
  t.is(await codeOf(wait.unlock(KEY)), CODES.NOT_AUTHORIZED, 'and nothing is tried again')
})
