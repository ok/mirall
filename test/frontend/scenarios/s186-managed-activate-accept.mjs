import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { startManagedConsole } from '../managed-console.mjs'

// An activation link opens the dialog filled from the signed configuration; Connect enrolls the install and locks what the organization sets, each
// locked control says who set it, and About gains one Organization row leading to the
// organization's page.
export default async function s186({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const fixture = await startManagedConsole({ supportEmail: 'it@acme.example' })
  fixture.serve({ 'network.relayMode': 'auto', 'audit.enabled': true, 'audit.retentionDays': 90 })
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1, env: fixture.env })
  try {
    await r.ok('the link opens the dialog with the organization, what it will see, its contact, and no settings list', async () => {
      await A.launch()
      await A.openDeepLink(fixture.link)
      await A.waitText('Connect Mirall to Acme Test GmbH?', 20000)
      assert(await A.hasText('it@acme.example'), 'the contact line')
      assert(!(await A.hasText('Relay')), 'no list of managed settings')
      assert(await A.hasText('Never your files, your spaces or who you share with'), 'what the organization will see')
      assert(await A.has({ role: 'link', contains: 'Privacy Policy' }), 'the privacy policy link')
      await A.shot('s186-ready', runDir)
    })

    await r.ok('Connect locks the settings and says so', async () => {
      await A.click({ role: 'button', name: 'Connect' })
      await A.waitText('Connected to Acme Test GmbH', 15000)
      await waitFor(() => fixture.upward.some((u) => u.call === 'instance-enroll'), 10000, 'the install enrolled')
      await A.gotoSettings('Activity Log')
      await A.waitText('Set by Acme Test GmbH', 10000)
      assert(await A.isDisabled({ role: 'switch', name: 'Record activity' }), 'the recording switch reads unavailable')
      assert(await A.isDisabled({ role: 'button', name: 'Delete…' }), 'the log cannot be deleted while recording is locked on')
      assert(!(await A.isDisabled({ role: 'button', name: 'Export…' })), 'export stays available')
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
      assert(!(await A.hasText('has revoked this computer’s license')), 'no revoked notice')
      assert(await A.hasText('Managed settings'), 'the list of what it manages')
      assert(await A.hasText('Keep events for 90 days'), 'a locked value in the words of its control')
      assert(await A.has({ role: 'button', name: 'Network' }), 'a row per settings page it locks')
      assert(!(await A.has({ role: 'button', name: 'Backup' })), 'no row for a page it leaves alone')
      await A.shot('s186-organization-page', runDir)
    })

    await r.ok('a managed settings row opens its settings page', async () => {
      await A.click({ role: 'button', name: 'Activity Log' })
      await A.waitText('Set by Acme Test GmbH', 8000)
      assert(await A.hasText('Record activity'), 'on the Activity Log settings')
    })

    await r.ok('the palette opens the organization page by its name', async () => {
      await A.press('cmd+k')
      await new Promise((res) => setTimeout(res, 600))
      await A.type({ role: 'combobox' }, 'acme')
      await new Promise((res) => setTimeout(res, 400))
      assert(await A.hasText('Open organization Acme Test GmbH'), 'the entry carries the organization name')
      await A.press('return')
      await A.waitText('Managed by Acme Test GmbH', 8000)
      assert(await A.hasText('Leave organization'), 'on the organization page')
      await A.shot('s186-palette-organization', runDir)
    })
  } catch {} finally {
    await fixture.close()
  }
  return { pass: r.summary(), instances: [A] }
}
