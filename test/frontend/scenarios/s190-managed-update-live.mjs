import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { makeReport, waitFor } from '../assert.mjs'
import { startManagedConsole } from '../managed-console.mjs'

// A newer configuration reaches an open Activity Log screen without a reload: retention 90 → 365.
export default async function s190({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const fixture = await startManagedConsole()
  fixture.serve({ 'audit.retentionDays': 90 })
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1, env: fixture.env })
  try {
    await r.ok('the locked retention follows a newer configuration', async () => {
      await A.launch()
      await A.openDeepLink(fixture.link)
      await A.waitText('Connect Mirall to Acme Test GmbH?', 20000)
      await A.click({ role: 'button', name: 'Connect' })
      await A.waitText('Connected to Acme Test GmbH', 15000)
      await A.gotoSettings('Activity Log')
      await waitFor(async () => (await A.nodeValue({ role: 'checkbox', name: '90 days' })) === '1', 10000, '90 days selected')
      fixture.serve({ 'audit.retentionDays': 365 })
      await waitFor(async () => (await A.nodeValue({ role: 'checkbox', name: '365 days' })) === '1', 30000, '365 days selected after the poll')
      await A.shot('s190-updated', runDir)
    })
  } catch {} finally {
    await fixture.close()
  }
  return { pass: r.summary(), instances: [A] }
}
