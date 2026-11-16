import { mkdirSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { Instance } from '../instance.mjs'
import { makeReport } from '../assert.mjs'
import { findKek, workerPid } from '../helpers.mjs'

// "Start fresh and create a new identity" on the locked screen sets the locked data aside and opens a
// new identity in the running worker: onboarding, then the app, with no worker restart.
export default async function s192({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1 })
  let lockedPid = 0

  try {
    await r.ok('an identity whose key the keychain no longer opens locks the data', async () => {
      await A.launch()
      await A.createSpaceOnly('Aurora')
      await A.quit()
      const kek = findKek(A.store)
      if (!kek) throw new Error('kek.enc not found under the instance store')
      writeFileSync(kek, randomBytes(64))
      await A.launch({ onboard: false })
      await A.waitText("Mirall can't open your data", 45000)
      lockedPid = workerPid(A.store)
    })
    await r.ok('starting fresh asks first, then opens onboarding on a new identity in the same worker', async () => {
      await A.click({ role: 'button', name: 'Start fresh and create a new identity' })
      await A.waitText('Start fresh?', 8000)
      await A.shot('s192-confirm', runDir)
      await A.click({ role: 'button', name: 'Set aside and start fresh' })
      await A.waitText('Welcome to Mirall', 90000)
      if (await A.hasText('Aurora')) throw new Error('the set-aside identity is still showing')
      if (workerPid(A.store) !== lockedPid) throw new Error('the worker was replaced: the new identity did not open in place')
      await A.shot('s192-onboarding', runDir)
    })
    await r.ok('the new identity works: a profile and a space', async () => {
      await A.onboard()
      await A.createSpaceOnly('Fresh')
      if (workerPid(A.store) !== lockedPid) throw new Error('the worker was replaced')
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
