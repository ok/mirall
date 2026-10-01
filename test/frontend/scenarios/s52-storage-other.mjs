import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { flatten } from '../tree.mjs'

// Drives the real renderer: open Storage Settings and expand the app-storage details
// disclosure. Confirms the disclosure is keyboard/AX-targetable (role=button + accessible name +
// expanded state — the a11y proof per testing.md §2), that it expands into the measured breakdown
// (a row per space, the shared-file index, the Activity Log, the download history and other), and
// that the Activity Log row leads to the settings page where it is deleted.
export default async function s52({ runDir, bootstrap }) {
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
      const toggle = flatten(await A.snap()).find((n) => n.role === 'button' && n.name === 'Hide details')
      assert(toggle && toggle.states.includes('expanded'), 'the disclosure reports its expanded state')
      assert(await A.hasText('Space: Aurora'), 'the space has its own row, titled as a space')
      assert(await A.hasText('cleans up whatever and whenever it can'), 'the card says once that Mirall cleans up on its own')
      assert(!(await A.hasText('Freed when you leave the space')), 'rows say what they hold, not how they are freed')
      assert(await A.hasText('Download history'), 'the download-history row renders')
      assert(await A.hasText('Other'), 'the other row renders')
      assert(await A.hasText('App updates'), 'the app-updates row renders')
      assert(await A.hasText('Replaced records'), 'the replaced-records row renders')
      assert(await A.has({ contains: 'Storage by category:' }), 'the meter carries one label naming every category')
      assert(!(await A.hasText('App database')), 'the unexplained residual row is gone')
      await A.shot('s52-storage-breakdown', runDir)
    })
    await r.ok('the Activity Log row links to where it is deleted', async () => {
      await A.click({ role: 'button', name: 'Manage Activity Log' })
      await waitFor(() => A.hasText('Choose what Mirall records on this device'), 10000, 'Activity Log settings')
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
