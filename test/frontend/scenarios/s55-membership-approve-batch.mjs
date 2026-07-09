import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { createSpaceWithInvite, joinPending as joinWith } from '../helpers.mjs'
import { makeReport, waitFor } from '../assert.mjs'

const settle = (ms = 600) => new Promise((res) => setTimeout(res, ms))

// Membership approval — four accounts. A (creator) + three joiners (Bob, Carol, Dan).
// All three join and wait; A reviews them in the batch modal, approves one via
// "Approve selected", then the rest via "Approve all". Exercises the multi-request
// JoinRequestBanner, the ApprovalModal (checkboxes + both footer actions), and the
// "N waiting" SpaceCard badge on the spaces list. Local-only (real Electron + AX).
export default async function s55 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 4 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 4 })
  const C = new Instance({ name: 'Carol', bootstrap, slot: 2, total: 4 })
  const D = new Instance({ name: 'Dan', bootstrap, slot: 3, total: 4 })

  try {
    let code
    await r.ok('A creates a space; Bob, Carol and Dan all join and wait', async () => {
      await A.launch(); await B.launch(); await C.launch(); await D.launch()
      code = await createSpaceWithInvite(A, { name: 'Aurora' })

      await joinWith(B, code)
      await joinWith(C, code)
      await joinWith(D, code)
    })

    await r.ok('the spaces list shows a "waiting" badge on the space card', async () => {
      await A.focus()
      await A.back()
      await A.waitText('Aurora', 10000)
      await waitFor(async () => A.hasText('waiting'), 30000, 'waiting badge on the card')
      await A.shot('s55-card-badge', runDir)
    })

    await r.ok('A opens the space and reviews the batch of requests', async () => {
      await A.click({ role: 'button', contains: 'Aurora' })
      await A.waitText('to join', 30000)
      await waitFor(async () => A.has({ role: 'button', contains: 'Review' }), 15000, 'Review targetable')
      await A.shot('s55-banner', runDir)
      await A.click({ role: 'button', contains: 'Review' })
      await A.waitText('Requests to join', 10000)
      await A.shot('s55-modal', runDir)
    })

    await r.ok('Approve selected lets one member (Bob) in', async () => {
      await A.click({ role: 'checkbox', name: 'Select Bob' })
      await settle()
      await A.click({ role: 'button', contains: 'Approve selected' })
      await waitFor(async () => !(await B.hasText('Waiting to be let in')), 30000, 'Bob let in')
    })

    await r.ok('Approve all lets the remaining members (Carol, Dan) in', async () => {
      await A.focus()
      await A.waitText('to join', 15000)
      await A.click({ role: 'button', contains: 'Review' })
      await A.waitText('Requests to join', 10000)
      await A.click({ role: 'button', contains: 'Approve all' })
      await waitFor(async () => !(await C.hasText('Waiting to be let in')), 30000, 'Carol let in')
      await waitFor(async () => !(await D.hasText('Waiting to be let in')), 30000, 'Dan let in')
      await A.shot('s55-all-approved', runDir)
    })
  } catch {}

  return { pass: r.summary(), instances: [A, B, C, D] }
}
