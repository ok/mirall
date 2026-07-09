import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { createSpaceWithInvite, joinPending as joinWith } from '../helpers.mjs'
import { makeReport, waitFor } from '../assert.mjs'

// Denying a requester in the batch modal removes their row immediately, leaving the
// others. Regression for "denied user stays in the list". Local-only (real Electron + AX).
export default async function s57 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 3 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 3 })
  const C = new Instance({ name: 'Carol', bootstrap, slot: 2, total: 3 })

  try {
    let code
    await r.ok('A creates a space; Bob and Carol join and wait', async () => {
      await A.launch(); await B.launch(); await C.launch()
      code = await createSpaceWithInvite(A, { name: 'Aurora' })
      await joinWith(B, code)
      await joinWith(C, code)
    })

    await r.ok('A opens the batch modal showing both requests', async () => {
      await A.focus()
      await A.waitText('to join', 30000)
      await waitFor(async () => A.has({ role: 'button', contains: 'Review' }), 15000, 'Review targetable')
      await A.click({ role: 'button', contains: 'Review' })
      await A.waitText('Requests to join', 10000)
      await waitFor(async () => A.has({ role: 'button', name: 'Deny Bob' }), 10000, 'Bob row present')
      await waitFor(async () => A.has({ role: 'button', name: 'Deny Carol' }), 10000, 'Carol row present')
    })

    await r.ok('denying Bob removes his row immediately; Carol remains', async () => {
      await A.click({ role: 'button', name: 'Deny Bob' })
      await waitFor(async () => !(await A.has({ role: 'button', name: 'Deny Bob' })), 15000, 'Bob row removed')
      await waitFor(async () => A.has({ role: 'button', name: 'Deny Carol' }), 10000, 'Carol still listed')
      await A.shot('s57-after-deny', runDir)
    })
  } catch {}

  return { pass: r.summary(), instances: [A, B, C] }
}
