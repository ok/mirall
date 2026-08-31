import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { createSpaceWithInvite, joinPending } from '../helpers.mjs'
import { makeReport, waitFor } from '../assert.mjs'

// Membership approval — list-level "waiting for approval" status pill. A creates an
// encrypted (v2) space; B joins and lands in the waiting state. B navigates BACK to the
// spaces list, where the space's card must surface a "Waiting for approval" pill — the
// joiner otherwise has no signal at the list level that the space isn't accessible yet.
// After A approves, the pill clears from B's list. Exercises SpaceCard's pending pill and
// its pending aria-label, driven by space.status flipping pending -> approved.
// "Waiting for approval" is unique to the list pill (the detail view reads "Waiting to be
// let into …"), so matching it confirms we're seeing the card, not the detail screen.
// Requires identity mode (real keychain).
export default async function s60 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  try {
    let code
    await r.ok('A creates an encrypted space; B joins and waits for approval', async () => {
      await A.launch()
      await B.launch()
      code = await createSpaceWithInvite(A, { name: 'Aurora' })
      await joinPending(B, code)
    })

    await r.ok("B's spaces list shows a \"Waiting for approval\" pill while pending", async () => {
      await B.back()
      await B.waitText('Aurora')   // back on the spaces list, card present
      await waitFor(async () => B.hasText('Waiting for approval'), 10000, "pending pill on B's list card")
      await B.shot('s60-pending-pill', runDir)
    })

    await r.ok("A approves Bob; the pill clears from B's list once approved", async () => {
      await A.focus()
      await A.waitText('wants to join', 30000)
      await waitFor(async () => A.has({ role: 'button', name: 'Approve Bob' }), 10000, 'Approve Bob targetable')
      await A.click({ role: 'button', name: 'Approve Bob' })
      await B.focus()
      await waitFor(async () => !(await B.hasText('Waiting for approval')), 30000, "pending pill gone from B's list")
      await B.shot('s60-approved-list', runDir)
    })
  } catch {}

  return { pass: r.summary(), instances: [A, B] }
}
