import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { createSpaceWithInvite, joinPending } from '../helpers.mjs'
import { makeReport, waitFor } from '../assert.mjs'

// Membership approval — single requester. A creates an encrypted (v2) space; B joins
// and sits in the "waiting to be let in" state; A sees the join-request banner and
// approves B; B's waiting state clears. Exercises JoinRequestBanner (single),
// the joiner waiting state, and the request/grant path through the UI.
// Requires identity mode (real keychain).
export default async function s54 ({ runDir, bootstrap }) {
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

    await r.ok('A sees the join request and the Approve control is targetable', async () => {
      await A.focus()
      await A.waitText('wants to join', 30000)
      await waitFor(async () => A.has({ role: 'button', name: 'Approve Bob' }), 10000, 'Approve Bob targetable')
      await A.shot('s54-request', runDir)
    })

    await r.ok('A approves Bob; Bob is let in (waiting state clears)', async () => {
      await A.click({ role: 'button', name: 'Approve Bob' })
      await waitFor(async () => !(await B.hasText('Waiting to be let in')), 30000, 'Bob no longer waiting')
      await A.shot('s54-approved-a', runDir)
      await B.shot('s54-approved-b', runDir)
    })

    await r.ok("A's request banner clears promptly once Bob is approved (FIX-APPROVE-LAG)", async () => {
      await A.focus()
      // Target the banner's Approve control specifically — the app-wide request toast
      // is sticky (manual-close) and keeps its "wants to join" text, so don't assert on that.
      // Tight window: pre-fix the banner-clear hint was gated behind the ~5s membership capture.
      await waitFor(async () => !(await A.has({ role: 'button', name: 'Approve Bob' })), 3000, 'approve control gone promptly')
    })
  } catch {}

  return { pass: r.summary(), instances: [A, B] }
}
