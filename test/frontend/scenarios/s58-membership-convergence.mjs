import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { createSpaceWithInvite, joinPending as joinAndWait } from '../helpers.mjs'
import { makeReport, waitFor } from '../assert.mjs'

// Convergence across members: when the owner approves a joiner, a co-member who did NOT
// perform the approval must also stop showing "wants to join" (i.e. admit them). This is
// the diverged-membership regression — Bob (a co-member) kept showing Carol as pending
// after Alice approved her. Also asserts the app-wide join-request TOAST on the co-member
// (its "Review" action button) is dismissed once another member resolves the request — the
// approval only needs doing once, so a sticky toast on every other member is stale. The
// banner uses Approve/Deny controls; only the toast carries a "Review" button. Local-only.
export default async function s58 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 3 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 3 })
  const C = new Instance({ name: 'Carol', bootstrap, slot: 2, total: 3 })

  try {
    let code
    await r.ok('A creates a space; Bob joins and is approved → Bob is a co-member', async () => {
      await A.launch(); await B.launch(); await C.launch()
      code = await createSpaceWithInvite(A, { name: 'Approval' })
      await joinAndWait(B, code)
      await A.focus()
      await A.waitText('wants to join', 30000)
      await A.click({ role: 'button', name: 'Approve Bob' })
      await waitFor(async () => !(await B.hasText('Waiting to be let in')), 30000, 'Bob admitted')
    })

    await r.ok('Carol joins; co-member Bob also sees her request (banner + toast)', async () => {
      await joinAndWait(C, code)
      await B.focus()
      await waitFor(async () => B.has({ role: 'button', name: 'Approve Carol' }), 60000, 'Bob (co-member) sees Carol pending')
      // The app-wide sticky toast for Carol's request is up on Bob (its "Review" action).
      await waitFor(async () => B.has({ role: 'button', name: 'Review' }), 30000, 'Bob sees the join-request toast for Carol')
      await B.shot('s58-bob-sees-request', runDir)
    })

    await r.ok('A approves Carol; Bob converges — banner AND toast clear', async () => {
      await A.focus()
      await waitFor(async () => A.has({ role: 'button', name: 'Approve Carol' }), 30000, 'A sees Carol pending')
      await A.click({ role: 'button', name: 'Approve Carol' })
      // The co-member who did NOT approve must stop showing Carol as pending.
      await B.focus()
      await waitFor(async () => !(await B.has({ role: 'button', name: 'Approve Carol' })), 60000, 'Bob no longer shows Carol as pending')
      // …and the now-stale app-wide toast must be dismissed without Bob ever touching it.
      await waitFor(async () => !(await B.has({ role: 'button', name: 'Review' })), 60000, 'Bob\'s join-request toast for Carol is dismissed')
      await B.shot('s58-bob-converged', runDir)
    })
  } catch {}

  return { pass: r.summary(), instances: [A, B, C] }
}
