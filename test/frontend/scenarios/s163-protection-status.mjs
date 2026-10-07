import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { makeReport } from '../assert.mjs'

// Profile → Backup before any backup: the row says the data is not backed up and opens the Backup
// screen, whose verdict offers the setup — the same screen Settings → Backup opens.
export default async function s163({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1 })

  try {
    await r.ok('Profile has one Backup row', async () => {
      await A.launch()
      await A.openAccount()
      await A.waitText('data is not backed up', 15000)
      if (await A.hasText('Identity key')) throw new Error('the identity key line is still there')
      await A.shot('s163-profile', runDir)
    })
    await r.ok('the Backup screen says what is missing and offers the setup', async () => {
      await A.click({ role: 'button', name: 'Backup' })
      await A.waitText("Your spaces aren't backed up", 15000)
      if (await A.hasText('Your Identity')) throw new Error('the identity section is still there')
      await A.shot('s163-status', runDir)
      await A.click({ role: 'button', name: 'Set up backup' })
      await A.waitText('Step 1 of 2', 8000)
      await A.click({ role: 'button', name: 'Cancel' })
    })
    await r.ok('Settings → Backup is the same screen', async () => {
      await A.gotoSettings('Backup')
      await A.waitText("Your spaces aren't backed up", 8000)
      if (!(await A.has({ role: 'switch', name: 'Back up automatically' }))) throw new Error('no backup switch')
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
