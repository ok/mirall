import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'

// App Storage's actions: each space row offers Leave by a name that says which space, and Cancel
// keeps it; Manage opens the Activity Log's settings and Back returns to Storage. A fresh profile
// has nothing worth freeing, so there is no Free up.
export default async function s155({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1 })

  try {
    await r.ok('launch, create a space, open Storage Settings', async () => {
      await A.launch()
      await A.createSpaceOnly('Aurora')
      await A.openManageStorage()
      await A.click({ role: 'button', name: 'Show details' })
      await A.waitText('Replaced records', 10000)
    })
    await r.ok('nothing to free on a fresh profile', async () => {
      assert(!(await A.hasText('can be freed')), 'no Free up row')
      await A.shot('s155-categories', runDir)
    })
    await r.ok('a space row offers Leave by name, and Cancel keeps the space', async () => {
      await A.click({ role: 'button', name: 'Leave Aurora…' })
      await A.waitText('Leave “Aurora”?', 8000)
      await A.click({ role: 'button', name: 'Cancel' })
      await waitFor(async () => !(await A.hasText('Leave “Aurora”?')), 8000, 'the dialog closes')
      assert(await A.has({ role: 'button', name: 'Leave Aurora…' }), 'the space is still listed')
    })
    await r.ok('Manage opens the Activity Log settings, and Back returns to Storage', async () => {
      await A.click({ role: 'button', name: 'Manage Activity Log' })
      await A.waitText('Choose what Mirall records on this device', 8000)
      await A.back()
      await A.waitText('Download Folder', 8000)
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
