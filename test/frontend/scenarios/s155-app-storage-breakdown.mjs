import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'

// App Storage's actions: Manage opens the Activity Log's settings and Back returns to Storage, and
// each space row's Open, named for its space, goes to that space, where Leave lives. A fresh
// profile has nothing worth freeing, so there is no Free up.
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
      await A.waitText('App updates', 10000)
    })
    await r.ok('nothing to free on a fresh profile', async () => {
      assert(!(await A.hasText('can be freed')), 'no Free up row')
      await A.shot('s155-categories', runDir)
    })
    await r.ok('Manage opens the Activity Log settings, and Back returns to Storage', async () => {
      await A.click({ role: 'button', name: 'Manage Activity Log' })
      await A.waitText('Choose what Mirall records on this device', 8000)
      await A.back()
      await A.waitText('Download Folder', 8000)
    })
    await r.ok('a space row opens its space, where it can be left', async () => {
      await A.click({ role: 'button', name: 'Show details' })
      await A.click({ role: 'button', name: 'Open Aurora' })
      await waitFor(async () => !(await A.hasText('Download Folder')), 8000, 'Storage closes')
      await A.click({ name: 'More' })
      await new Promise((resolve) => setTimeout(resolve, 400))
      assert(await A.has({ name: 'Leave Space' }), 'the space screen offers Leave')
      await A.press('Escape')
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
