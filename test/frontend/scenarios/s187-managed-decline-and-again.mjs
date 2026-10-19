import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { startManagedConsole } from '../managed-console.mjs'

// Not now changes nothing, and the same link asks again.
export default async function s187({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const fixture = await startManagedConsole()
  fixture.serve({ 'audit.enabled': true })
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1, env: fixture.env })
  try {
    await r.ok('Not now closes the dialog and leaves the install unmanaged', async () => {
      await A.launch()
      await A.openDeepLink(fixture.link)
      await A.waitText('Connect Mirall to Acme Test GmbH?', 20000)
      await A.click({ role: 'button', name: 'Not now' })
      await waitFor(async () => !(await A.hasText('Connect Mirall to Acme Test GmbH?')), 8000, 'the dialog closed')
      await A.gotoSettings('Activity Log')
      await A.waitText('Record activity', 8000)
      assert(!(await A.hasText('Set by')), 'nothing locked')
    })

    await r.ok('the same link opens the dialog again', async () => {
      await A.openDeepLink(fixture.link)
      await A.waitText('Connect Mirall to Acme Test GmbH?', 20000)
      await A.shot('s187-again', runDir)
    })
  } catch {} finally {
    await fixture.close()
  }
  return { pass: r.summary(), instances: [A] }
}
