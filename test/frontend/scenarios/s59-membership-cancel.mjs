import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { createSpaceWithInvite, joinPending } from '../helpers.mjs'
import { makeReport, waitFor } from '../assert.mjs'

// When a joiner cancels (withdraws) a pending request, the member who saw it must stop
// showing "wants to join". Regression for the un-gossiped cancellation. The sticky
// request toast keeps its text, so the assertion targets the banner's Approve control.
// Local-only (real Electron + AX).
export default async function s59 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  try {
    await r.ok('A sees Bob\'s join request, then Bob cancels and A\'s banner clears', async () => {
      await A.launch(); await B.launch()
      const code = await createSpaceWithInvite(A, { name: 'Approval' })
      await joinPending(B, code)

      await A.focus()
      await waitFor(async () => A.has({ role: 'button', name: 'Approve Bob' }), 30000, 'A sees Bob request')
      await A.shot('s59-a-sees-request', runDir)

      // Bob withdraws via the pending view's Cancel request control.
      await B.focus()
      await B.click({ role: 'button', name: 'Cancel request' })

      // A's banner must clear.
      await A.focus()
      await waitFor(async () => !(await A.has({ role: 'button', name: 'Approve Bob' })), 30000, 'A banner cleared after cancel')
      await A.shot('s59-a-cleared', runDir)
    })
  } catch {}

  return { pass: r.summary(), instances: [A, B] }
}
