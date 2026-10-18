import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { startManagedConsole } from '../managed-console.mjs'

// An activation link opens the dialog filled from the signed configuration; Connect locks what the
// organization sets, each locked control says who set it, and About gains one Organization row
// leading to the organization's page.
export default async function s186({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const fixture = await startManagedConsole({ supportEmail: 'it@acme.example' })
  fixture.serve({ 'network.relayMode': 'auto', 'audit.enabled': true, 'audit.retentionDays': 90 })
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1, env: fixture.env })
  try {
    await r.ok('the link opens the dialog with the organization and its contact, and no settings list', async () => {
      await A.launch()
      await A.openDeepLink(fixture.link)
      await A.waitText('Connect Mirall to Acme Test GmbH?', 20000)
      assert(await A.hasText('it@acme.example'), 'the contact line')
      assert(!(await A.hasText('Relay')), 'no list of managed settings')
      await A.shot('s186-ready', runDir)
    })

    await r.ok('Connect locks the settings and says so', async () => {
      await A.click({ role: 'button', name: 'Connect' })
      await A.waitText('Connected to Acme Test GmbH', 15000)
      await A.gotoSettings('Activity Log')
      await A.waitText('Set by Acme Test GmbH', 10000)
      assert(await A.isDisabled({ role: 'switch', name: 'Record activity' }), 'the recording switch reads unavailable')
      await A.shot('s186-activity-log-locked', runDir)
      await A.gotoSettings('Network')
      await A.waitText('Set by Acme Test GmbH', 10000)
    })

    await r.ok('About has one Organization row; its page names the organization and offers Leave', async () => {
      await A.openAccount()
      await A.click({ role: 'button', name: 'About Mirall' })
      await waitFor(() => A.has({ role: 'button', name: 'Organization' }), 10000, 'the Organization row')
      assert(!(await A.hasText('Leave organization')), 'no Leave on About itself')
      await A.click({ role: 'button', name: 'Organization' })
      await A.waitText('Managed by Acme Test GmbH', 8000)
      assert(await A.hasText('Configuration updated'), 'when it was last updated')
      assert(await A.hasText('Email support'), 'the support row')
      assert(await A.hasText('Leave organization'), 'Leave lives here')
      await A.shot('s186-organization-page', runDir)
    })
  } catch {} finally {
    await fixture.close()
  }
  return { pass: r.summary(), instances: [A] }
}
