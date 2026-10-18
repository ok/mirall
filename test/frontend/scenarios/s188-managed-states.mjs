import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { makeReport, assert } from '../assert.mjs'
import { startManagedConsole } from '../managed-console.mjs'

// The dialog's other outcomes: an organization that cannot be reached (with Try again), a link with
// nothing set up for it yet, and a link that cannot be used.
export default async function s188({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const fixture = await startManagedConsole()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1, env: fixture.env })
  try {
    await r.ok('unreachable, then Try again once the organization answers', async () => {
      await A.launch()
      fixture.fail(503)
      await A.openDeepLink(fixture.link)
      await A.waitText('Couldn’t reach your organization', 20000)
      await A.shot('s188-unreachable', runDir)
      fixture.serve({ 'audit.enabled': true })
      await A.click({ role: 'button', name: 'Try again' })
      await A.waitText('Connect Mirall to Acme Test GmbH?', 20000)
      await A.click({ role: 'button', name: 'Not now' })
    })

    await r.ok('a link with no configuration yet says so and offers no Connect', async () => {
      fixture.fail(404)
      await A.openDeepLink(fixture.link)
      await A.waitText('This link isn’t set up yet', 20000)
      assert(!(await A.has({ role: 'button', name: 'Connect' })), 'no Connect')
      await A.click({ role: 'button', name: 'Close' })
    })
  } catch {} finally {
    await fixture.close()
  }
  return { pass: r.summary(), instances: [A] }
}
