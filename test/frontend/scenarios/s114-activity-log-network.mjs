import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { makeReport } from '../assert.mjs'
import { flatten } from '../tree.mjs'

// The Network category and the cross-link that reaches it. A real outage cannot be driven from the
// AX layer, so this asserts the shape: the chip exists and is addressable by name/role/state, the
// empty state reads as good news rather than a failed search, and the preset survives the jump from
// Network status — which is also the only thing that catches openActivityLog being wired straight
// to an onClick, where React's MouseEvent would be spread into the filters.
export default async function s114 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1 })

  try {
    // macOS surfaces an aria-pressed button as a checkbox whose value carries the pressed state,
    // which is how the five shipped chips already appear — the new one must match, or it is an a11y
    // gap in the control rather than a miss in the test.
    await r.ok('the Network chip is targetable by name, role and pressed state', async () => {
      await A.launch()
      await A.openActivityLog()
      const chip = async () => flatten(await A.snap()).find((n) => n.role === 'checkbox' && n.name === 'Network')
      const before = await chip()
      if (!before) throw new Error('the Network filter chip is not in the accessibility tree')
      if (before.value !== '0') throw new Error(`chip is not unpressed to begin with (value=${before.value})`)

      await A.click({ role: 'checkbox', name: 'Network' })
      const after = await chip()
      if (after?.value !== '1') throw new Error(`aria-pressed did not reach the AX tree (value=${after?.value})`)
    })

    await r.ok('an empty network log reads as good news, not a failed search', async () => {
      if (await A.hasText('No events match')) {
        throw new Error('the generic filtered-empty copy is wrong here — nothing matching is the outcome you want')
      }
      await A.waitText('No connection problems recorded', 8000)
      await A.shot('s114-network-empty', runDir)
    })

    await r.ok('Clear all restores the unfiltered list', async () => {
      await A.click({ name: 'Clear all' })
      await A.waitText('Nothing recorded yet', 8000)
    })

    await r.ok('every one of the six category chips is reachable', async () => {
      for (const label of ['Members', 'Files', 'Folders', 'Security', 'Network', 'All']) {
        await A.click({ role: 'checkbox', name: label })
      }
    })

    await r.ok('Network status cross-links into the log, pre-filtered', async () => {
      await A.openNetworkStatus()
      await A.click({ name: 'Connection history' })
      await A.waitText('No connection problems recorded', 8000)
      await A.shot('s114-crosslink', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
