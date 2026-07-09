import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { connectInSpace, joinPending } from '../helpers.mjs'
import { makeReport, waitFor } from '../assert.mjs'

// A co-member sees a pending join request — and KEEPS seeing it after the requester goes OFFLINE
// (the request is durable/converged, not tied to a live connection). Alice owns the space, Bob is an
// approved co-member; Carol requests and then goes offline. Bob (who did not receive the grant) must
// still surface Carol: the in-space "Approve Carol" banner and the list "N waiting" pill. This is the
// pending-request convergence the prior fix added, exercised through the UI. Local-only. Approval ON.
export default async function s63 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 3 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 3 })
  const C = new Instance({ name: 'Carol', bootstrap, slot: 2, total: 3 })

  try {
    let code
    await r.ok('Alice creates a space; Bob joins and is approved → co-member', async () => {
      await A.launch(); await B.launch(); await C.launch()
      code = await connectInSpace(A, B, { name: 'Aurora' })
    })

    await r.ok('Carol requests; Alice records it, then Carol goes offline', async () => {
      await joinPending(C, code)
      await A.focus()
      await waitFor(async () => A.has({ role: 'button', name: 'Approve Carol' }), 60000, 'Alice sees Carol pending')
      await C.kill()
    })

    await r.ok('co-member Bob surfaces Carol\'s request even though Carol is offline', async () => {
      await B.focus()
      await waitFor(async () => B.has({ role: 'button', name: 'Approve Carol' }), 60000, 'Bob (co-member) sees Carol pending')
      await B.shot('s63-bob-sees-carol', runDir)
      await B.back()
      await B.waitText('Aurora')
      await waitFor(async () => B.hasText('1 waiting'), 30000, 'member-side waiting pill on Bob\'s card')
      await B.shot('s63-bob-waiting-pill', runDir)
    })
  } catch {}

  return { pass: r.summary(), instances: [A, B, C] }
}
