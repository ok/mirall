import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { connectInSpace, joinPending } from '../helpers.mjs'
import { makeReport, waitFor } from '../assert.mjs'

const settle = (ms = 600) => new Promise((res) => setTimeout(res, ms))

// Owner-side convergence when a CO-MEMBER approves a joiner (the reported bug). Alice owns the space;
// Bob is approved and is a co-member; Carol requests and BOB (not Alice) approves her. The owner Alice —
// who performed no approval — must converge: she must NOT keep showing Carol as a pending approval
// ("wants to join" / Approve Carol), and Carol must appear in Alice's member list. Local-only.
export default async function s65 ({ runDir, bootstrap }) {
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

    await r.ok('Carol joins; Bob (co-member) approves her', async () => {
      await joinPending(C, code)
      await B.focus()
      await waitFor(async () => B.has({ role: 'button', name: 'Approve Carol' }), 60000, 'Bob sees Carol pending')
      await B.click({ role: 'button', name: 'Approve Carol' })
      await waitFor(async () => !(await C.hasText('Waiting to be let in')), 60000, 'Carol admitted')
    })

    await r.ok('Alice (owner, did not approve) shows no pending and lists Carol as a member', async () => {
      await A.focus()
      await waitFor(async () => !(await A.has({ role: 'button', name: 'Approve Carol' })), 60000, 'no Approve Carol on Alice')
      await waitFor(async () => !(await A.hasText('wants to join')), 30000, 'no "wants to join" banner on Alice')
      if (await A.has({ role: 'button', name: 'Show all' })) {
        await A.click({ role: 'button', name: 'Show all' }); await A.focus(); await settle()
      }
      await waitFor(async () => A.hasText('Carol'), 60000, 'Carol listed as a member on Alice')
      await A.shot('s65-owner-converged', runDir)
    })
  } catch {}

  return { pass: r.summary(), instances: [A, B, C] }
}
