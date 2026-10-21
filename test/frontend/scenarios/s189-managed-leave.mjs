import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { startManagedConsole } from '../managed-console.mjs'

// Leaving from the Organization page tells the organization, returns to About with the row gone,
// and the settings are the person's again — after a relaunch too.
export default async function s189({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const fixture = await startManagedConsole()
  fixture.serve({ 'audit.enabled': true })
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1, env: fixture.env })
  try {
    await r.ok('connect, then leave from the Organization page', async () => {
      await A.launch()
      await A.openDeepLink(fixture.link)
      await A.waitText('Connect Mirall to Acme Test GmbH?', 20000)
      await A.click({ role: 'button', name: 'Connect' })
      await A.waitText('Connected to Acme Test GmbH', 15000)
      await A.openAccount()
      await A.click({ role: 'button', name: 'About Mirall' })
      await A.click({ role: 'button', name: 'Organization' })
      await A.waitText('Managed by Acme Test GmbH', 8000)
      await A.click({ role: 'button', name: 'Leave…' })
      await A.waitText('Leave Acme Test GmbH?', 8000)
      assert(await A.hasText('Mirall tells Acme Test GmbH that this computer has left.'), 'the organization hears of it')
      await A.shot('s189-confirm', runDir)
      await A.click({ role: 'button', name: 'Leave', last: true })
      await A.waitText('Left Acme Test GmbH', 15000)
      assert(fixture.upward.at(-1)?.report.state === 'left', 'the organization was told')
      await waitFor(async () => !(await A.has({ role: 'button', name: 'Organization' })), 10000, 'the Organization row is gone')
      assert(await A.hasText('Version, updates'), 'back on About')
    })

    await r.ok('after a relaunch the install is still unmanaged', async () => {
      await A.relaunch()
      await A.gotoSettings('Activity Log')
      await A.waitText('Record activity', 8000)
      assert(!(await A.hasText('Set by')), 'nothing locked')
      assert(!(await A.isDisabled({ role: 'button', name: 'Delete…' })), 'the log can be deleted again')
    })
  } catch {} finally {
    await fixture.close()
  }
  return { pass: r.summary(), instances: [A] }
}
