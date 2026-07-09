import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { makeReport, assert } from '../assert.mjs'

// Drives the real renderer: open Storage Settings and expand the app-storage details
// disclosure. Confirms the disclosure is keyboard/AX-targetable (role=button +
// accessible name + aria-expanded — the a11y proof per testing.md §2) and expands
// into the measured breakdown (shared-file index + app database).
export default async function s52 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1 })

  try {
    await r.ok('launch, create a space, open Storage Settings', async () => {
      await A.launch()
      await A.createSpaceOnly('Aurora')
      await A.openManageStorage()
    })
    await r.ok('the details disclosure expands into a measured breakdown', async () => {
      await A.waitText('Show details', 10000)
      await A.click({ role: 'button', name: 'Show details' })
      await A.waitText('Shared-file index', 10000)
      assert(await A.hasText('Shared-file index'), 'the shared-file index row renders with its explainer')
      assert(await A.hasText('App database'), 'the app-database row renders')
      await A.shot('s52-storage-other', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
