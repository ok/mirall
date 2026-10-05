import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { makeReport, waitFor } from '../assert.mjs'

const PASS = 'a long enough passphrase'

// A recovery key restored on a fresh install: onboarding offers it, the key is adopted, and the app
// opens read-only with a banner — never onboarding — because nobody holding the profile has sent it
// back yet. The banner's details offer starting fresh, which asks first and can be cancelled.
export default async function s159({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'NewDevice', bootstrap, slot: 1, total: 2 })
  const keyFile = path.join(runDir, 'alice.mirallkey')
  const passphrase = { role: 'textfield', name: 'Passphrase' }
  const restore = { role: 'button', name: 'Restore identity' }

  try {
    await r.ok('back up the recovery key', async () => {
      await A.launch()
      await A.openAccount()
      await A.click({ role: 'button', name: 'Back up your recovery key' })
      await A.setRaw({ role: 'textfield', name: 'Choose a passphrase' }, PASS)
      await A.setRaw({ role: 'textfield', name: 'Confirm passphrase' }, PASS)
      await A.nativeChoosePath(keyFile, { trigger: () => A.click({ role: 'button', name: 'Save backup file…' }) })
      await A.waitText('Recovery key saved to your chosen location.', 30000)
      await A.quit()
    })
    await r.ok('onboarding offers a restore with a recovery key', async () => {
      await B.launch({ onboard: false })
      await B.waitText('Welcome to Mirall', 45000)
      if (!(await B.has({ role: 'button', name: 'Already have a recovery key? Restore your identity' }))) throw new Error('no restore link on onboarding')
      await B.shot('s159-onboarding', runDir)
    })
    await r.ok('the adopted key opens the app read-only, not onboarding', async () => {
      await B.click({ role: 'button', name: 'Already have a recovery key? Restore your identity' })
      await B.nativeChoosePath(keyFile, { trigger: () => B.click({ role: 'button', name: 'Choose recovery key file…' }) })
      await B.waitText('Enter the passphrase for this recovery key.', 8000)
      await B.setRaw(passphrase, PASS)
      await waitFor(async () => !(await B.isDisabled(restore)), 8000, 'Restore available')
      await B.click(restore)
      await B.waitText('Your identity is back', 90000)
      if (!(await B.has({ role: 'button', name: 'Create Space' }))) throw new Error('the app shell is not showing')
      await B.click({ role: 'button', name: 'Details' })
      await B.waitText('Waiting for someone you share a space with to come online…', 15000)
      for (const sel of [
        { role: 'textfield', name: 'Invite code for one of your spaces' },
        { role: 'button', name: 'Rejoin with invite' },
        { role: 'button', name: 'Start a new identity instead' },
      ]) {
        if (!(await B.has(sel))) throw new Error(`missing ${sel.role} ${sel.name}`)
      }
      if (await B.hasText('Welcome to Mirall')) throw new Error('onboarding is showing over a restored identity')
      await B.shot('s159-restoring', runDir)
    })
    await r.ok('starting fresh asks first and can be cancelled', async () => {
      await B.click({ role: 'button', name: 'Start a new identity instead' })
      await B.waitText('Start fresh?', 8000)
      await B.shot('s159-start-fresh', runDir)
      await B.click({ role: 'button', name: 'Cancel' })
      await waitFor(async () => !(await B.hasText('Start fresh?')), 8000, 'confirm closed')
      await B.waitText('Waiting for someone you share a space with to come online…', 8000)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
