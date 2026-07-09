import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { createSpaceWithInvite, joinPending as joinAndWait } from '../helpers.mjs'
import { makeReport, waitFor } from '../assert.mjs'

const settle = (ms = 600) => new Promise((res) => setTimeout(res, ms))

// Member identity convergence: a late joiner derives a pre-existing co-member purely from
// replicated records and must render that member by their REAL name — not the "Unknown"
// placeholder that appeared when identity was only ever read from a live handshake. Avatar
// bytes (Symptom 1) are covered at the unit/integration/flow layers (no avatar-upload UI in
// onboarding); this asserts the visible "Unknown" regression (Image 3). Local-only.
export default async function s61 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 3 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 3 })
  const C = new Instance({ name: 'Carol', bootstrap, slot: 2, total: 3 })

  try {
    let code
    await r.ok('A creates a space; Bob joins and is approved → Bob is a co-member', async () => {
      await A.launch(); await B.launch(); await C.launch()
      code = await createSpaceWithInvite(A, { name: 'Approval Test' })
      await joinAndWait(B, code)
      await A.focus()
      await A.waitText('wants to join', 30000)
      await A.click({ role: 'button', name: 'Approve Bob' })
      await waitFor(async () => !(await B.hasText('Waiting to be let in')), 30000, 'Bob admitted')
    })

    await r.ok('Carol joins late and is approved', async () => {
      await joinAndWait(C, code)
      await A.focus()
      await waitFor(async () => A.has({ role: 'button', name: 'Approve Carol' }), 60000, 'A sees Carol pending')
      await A.click({ role: 'button', name: 'Approve Carol' })
      await waitFor(async () => !(await C.hasText('Waiting to be let in')), 30000, 'Carol admitted')
    })

    await r.ok('Carol sees pre-existing member Bob by real name, never "Unknown"', async () => {
      await C.focus()
      await C.waitText('Members', 60000)
      await C.click({ role: 'button', name: 'Show all' })
      await C.focus(); await settle()
      await waitFor(async () => C.hasText('Bob'), 60000, 'Carol sees Bob by name')
      await waitFor(async () => !(await C.hasText('Unknown')), 60000, 'no member renders as Unknown')
      await C.shot('s61-carol-members', runDir)
    })
  } catch {}

  return { pass: r.summary(), instances: [A, B, C] }
}
