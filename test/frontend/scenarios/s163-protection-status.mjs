import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { makeReport } from '../assert.mjs'

// Profile → Protection before any backup: the row says the data is not backed up, the status screen's
// verdict offers the setup, and its settings row and Settings' status row lead to each other.
export default async function s163({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1 })

  try {
    await r.ok('Profile has one Protection row instead of the identity line', async () => {
      await A.launch()
      await A.openAccount()
      await A.waitText('data is not backed up', 15000)
      if (await A.hasText('Identity protection')) throw new Error('the old identity line is still there')
      await A.shot('s163-profile', runDir)
    })
    await r.ok('the status screen says what is missing and offers the setup', async () => {
      await A.click({ role: 'button', name: 'Protection' })
      await A.waitText("Your data isn't backed up", 15000)
      await A.waitText('Identity key on this computer', 8000)
      await A.shot('s163-status', runDir)
      await A.click({ role: 'button', name: 'Set up backup' })
      await A.waitText('Step 1 of 3', 8000)
      await A.click({ role: 'button', name: 'Cancel' })
    })
    await r.ok('status and settings lead to each other', async () => {
      await A.click({ role: 'button', name: 'Backup & Recovery Settings' })
      await A.waitText('Restoring on a new computer', 8000)
      await A.click({ role: 'button', name: 'Protection Status' })
      await A.waitText("Your data isn't backed up", 8000)
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
