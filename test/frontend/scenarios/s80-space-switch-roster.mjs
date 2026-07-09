import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, waitFor } from '../assert.mjs'

// The members roster and online set are per-space projections (useMembers re-fetches
// spaces:list + members:online on every switch, self included worker-side). Switching
// between a shared and a solo space must never bleed one space's roster into the other.
export default async function s80 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  try {
    await r.ok('A and B share "Aurora"; A sees Bob in the roster', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.focus()
      await A.waitText('Members', 60000)
      await A.waitText('Bob', 60000)
      await A.shot('s80-aurora', runDir)
    })

    await r.ok('a second, solo space shows no trace of Aurora’s roster', async () => {
      await A.back()
      await A.click({ role: 'button', name: 'Create Space' })
      await A.waitText('Create a New Space')
      await A.type({ role: 'textfield' }, 'Borealis')
      await A.click({ role: 'button', name: 'Initialize Space' })
      await A.waitText('Space Created')
      await A.click({ role: 'button', name: 'Done' })
      await A.waitText('Members', 30000)
      await waitFor(async () => !(await A.hasText('Bob')), 20000, 'solo space roster has no Bob')
      await A.shot('s80-borealis', runDir)
    })

    await r.ok('switching back re-derives Aurora’s roster and online set', async () => {
      await A.back()
      await A.click({ name: 'Open Aurora' })
      await A.waitText('Members', 30000)
      await waitFor(async () => A.hasText('Bob'), 30000, 'Aurora roster shows Bob again')
      await A.shot('s80-back-to-aurora', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
