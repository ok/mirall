import { mkdirSync, copyFileSync, writeFileSync, readdirSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { makeReport } from '../assert.mjs'
import { findKek, workerPid } from '../helpers.mjs'

const LOCKED = "Mirall can't open your data"
const retry = { role: 'button', name: 'Try again' }

// "Try again" on the locked screen opens the identity in the worker that is already running. While
// the keychain still cannot open the set-aside key the screen stays and says so by staying; once it
// can (the original kek.enc is back among the set-aside keys), the same worker opens the data — the
// space the identity had, not onboarding — and no new worker was started.
export default async function s191({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1 })
  let original = null
  let lockedPid = 0

  try {
    await r.ok('an identity with a space is set up and its key kept aside', async () => {
      await A.launch()
      await A.createSpaceOnly('Aurora')
      await A.quit()
      const kek = findKek(A.store)
      if (!kek) throw new Error('kek.enc not found under the instance store')
      original = path.join(runDir, 's191-original-kek.enc')
      copyFileSync(kek, original)
      writeFileSync(kek, randomBytes(64))
    })
    await r.ok('the data is locked, and Try again with nothing better to offer leaves it locked in the same worker', async () => {
      await A.launch({ onboard: false })
      await A.waitText(LOCKED, 45000)
      lockedPid = workerPid(A.store)
      await A.click(retry)
      // The refusal is a fast answer from the worker and nothing on screen changes with it, so
      // there is no signal to wait for: a pause long enough for the round trip, then the checks.
      await new Promise((resolve) => setTimeout(resolve, 4000))
      if (!(await A.hasText(LOCKED))) throw new Error('the locked screen went away on a key that still cannot open the data')
      if (await A.has({ role: 'alert' })) throw new Error('a refused retry is not an error, yet one is showing')
      if (workerPid(A.store) !== lockedPid) throw new Error('the worker was replaced by a retry')
      await A.shot('s191-still-locked', runDir)
    })
    await r.ok('once the keychain can open the original key, Try again opens the data in place', async () => {
      const kek = findKek(A.store)
      // Newest first: this is the key the retry finds before the garbage one the launch set aside.
      copyFileSync(original, path.join(path.dirname(kek), 'kek.enc.unreadable-9999-12-31T00-00-00'))
      await A.click(retry)
      await A.waitText('Aurora', 90000)
      if (await A.hasText('Welcome to Mirall')) throw new Error('onboarding is showing over an identity that exists')
      if (workerPid(A.store) !== lockedPid) throw new Error('the worker was replaced: the data did not open in place')
      if (!readdirSync(path.dirname(kek)).some((n) => n.startsWith('kek.enc.unused-'))) throw new Error('the minted key was not set aside')
      await A.shot('s191-opened', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
