import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { startManagedConsole } from '../managed-console.mjs'

// A license the organization revoked: the Organization page says so and the settings stay locked;
// Leave no longer promises to tell the organization, and still leaves.
export default async function s196({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const fixture = await startManagedConsole()
  fixture.serve({ 'audit.enabled': true })
  fixture.revoke()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1, env: fixture.env })
  try {
    await r.ok('the Organization page says the license is revoked', async () => {
      await A.launch()
      await A.openDeepLink(fixture.link)
      await A.waitText('Connect Mirall to Acme Test GmbH?', 20000)
      await A.click({ role: 'button', name: 'Connect' })
      await A.waitText('Connected to Acme Test GmbH', 15000)
      await waitFor(() => fixture.upward.length > 0, 10000, 'the enrollment was answered')
      await A.openAccount()
      await A.click({ role: 'button', name: 'About Mirall' })
      await A.click({ role: 'button', name: 'Organization' })
      await A.waitText('Acme Test GmbH has revoked this computer’s license', 10000)
      assert(await A.hasText('Managed by Acme Test GmbH'), 'still managed')
      await A.shot('s196-revoked', runDir)
    })

    await r.ok('Leave makes no promise to tell the organization, and leaves', async () => {
      const sent = fixture.upward.length
      await A.click({ role: 'button', name: 'Leave…' })
      await A.waitText('Leave Acme Test GmbH?', 8000)
      assert(!(await A.hasText('Mirall tells Acme Test GmbH')), 'no report note')
      await A.click({ role: 'button', name: 'Leave', last: true })
      await A.waitText('Left Acme Test GmbH', 15000)
      assert(fixture.upward.length === sent, 'nothing sent after the revocation')
    })
  } catch {} finally {
    await fixture.close()
  }
  return { pass: r.summary(), instances: [A] }
}
