import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { makeReport } from '../assert.mjs'

// Profile page (was Account): the groups render, each row reaches its destination, the identity row
// stays out of the interactive tree, and the Profile command lands here now that About's screen is gone.
export default async function s108 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1 })

  try {
    await r.ok('the avatar opens a page titled Profile', async () => {
      await A.launch()
      await A.click({ role: 'button', name: 'Profile' })
      await A.waitText('Your profile, this device', 8000)
      await A.shot('s108-profile', runDir)
    })

    await r.ok('the group labels render and the old section headings are gone', async () => {
      await A.waitText('This device', 8000)
      await A.waitText('App', 8000)
      // "Security" was a section heading over a one-line card; its content is the identity row now.
      // Don't assert on "Activity" — the Activity Log row legitimately contains that word.
      if (await A.hasText('Security')) throw new Error('stale Security heading on the profile page')
    })

    await r.ok('the Connection row reaches the diagnostics screen', async () => {
      await A.click({ role: 'button', name: 'Connection' })
      await A.waitText('Network status', 8000)
      await A.back()
      await A.waitText('This device', 8000)
    })

    await r.ok('the Activity Log row reaches the log viewer', async () => {
      await A.click({ role: 'button', name: 'Activity Log' })
      await A.waitText('A record of what happened', 8000)
      await A.back()
      await A.waitText('This device', 8000)
    })

    // Information, not a control: readable but never a focus stop.
    await r.ok('identity protection renders as static text', async () => {
      await A.waitText('Identity protection', 8000)
      if (await A.has({ role: 'button', name: 'Identity protection' })) {
        throw new Error('identity row should not be a button')
      }
    })

    await r.ok('the Profile command lands on the Profile page', async () => {
      await A.back()
      await A.press('cmd+k')
      await new Promise((res) => setTimeout(res, 600))
      await A.type({ role: 'combobox' }, 'profile')
      await A.press('return')
      await A.waitText('Your profile, this device', 8000)
      await A.waitText('App', 8000)
      await A.shot('s108-profile-command', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
