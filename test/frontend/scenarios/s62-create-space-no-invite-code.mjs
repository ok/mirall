import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { makeReport } from '../assert.mjs'

// The post-creation "Space Created" confirmation no longer hands out a raw invite
// code: sharing now lives in the in-space invite modal (link + auto-approval). This
// asserts the confirmation step is a clean confirmation with none of the old
// "Share Access" label / "Copy Code" invite-code controls.
export default async function s62 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1 })

  try {
    await r.ok('launch + reach the Space Created confirmation', async () => {
      await A.launch()
      await A.click({ role: 'button', name: 'Create Space' })
      await A.waitText('Create a New Space')
      await A.type({ role: 'textfield' }, 'Aurora')
      await A.click({ role: 'button', name: 'Initialize Space' })
      await A.waitText('Space Created')
    })

    await r.ok('confirmation shows the space and the invite-from-inside copy', async () => {
      if (!(await A.hasText('Aurora'))) throw new Error('created space name not shown')
      if (!(await A.hasText('from inside the space'))) throw new Error('reworded confirmation copy not shown')
      await A.shot('s62-space-created', runDir)
    })

    await r.ok('no invite-code UI on the confirmation', async () => {
      if (await A.has({ role: 'button', name: 'Copy Code' })) throw new Error('Copy Code button still present')
      if (await A.hasText('Share Access')) throw new Error('Share Access label still present')
    })

    await r.ok('Done dismisses the modal into the new space', async () => {
      await A.click({ role: 'button', name: 'Done' })
      await A.waitText('Aurora')
      if (await A.hasText('Space Created')) throw new Error('confirmation modal did not close')
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
