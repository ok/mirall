import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { createSpaceWithInvite, joinPending } from '../helpers.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'

const WARNING = 'Carol has already been approved'
const sleep = (ms) => new Promise((res) => setTimeout(res, ms))

// The roles of every node on the path from the root to the first node whose own text holds `text`.
function rolesAbove(node, text, path = []) {
  if (!node || typeof node !== 'object') return null
  const here = [...path, node.role]
  const own = `${node.name ?? ''} ${node.description ?? ''} ${typeof node.value === 'string' ? node.value : ''}`
  if (own.includes(text)) return here
  for (const child of node.children ?? []) {
    const found = rolesAbove(child, text, here)
    if (found) return found
  }
  return null
}

// A co-member's Deny can land on a joiner another member already let in: approval cannot be
// revoked, so Bob must be told Carol keeps access, in a polite status toast that stays up. Bob's
// membership fold waits HOLD_MS before its first run (MIRALL_DERIVE_DEBOUNCE_MS), so Carol's request
// reaches him only live and stays on his screen after Alice approves her — the stale banner a real
// user clicks — and Carol is offline, so she cannot join Bob's roster through a handshake first. The
// steps assert they finished inside that window rather than trusting it. Local-only.
const HOLD_MS = 300000
export default async function s150({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 3 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 3, env: { MIRALL_DERIVE_DEBOUNCE_MS: String(HOLD_MS) } })
  let bobUp = 0
  const C = new Instance({ name: 'Carol', bootstrap, slot: 2, total: 3 })

  try {
    let code
    await r.ok('Alice creates a space; Bob joins and is approved', async () => {
      await A.launch()
      bobUp = Date.now()
      await B.launch()
      await C.launch()
      code = await createSpaceWithInvite(A, { name: 'Approval' })
      await joinPending(B, code)
      await A.focus()
      await A.waitText('wants to join', 30000)
      await A.click({ role: 'button', name: 'Approve Bob' })
      await waitFor(async () => !(await B.hasText('Waiting to be let in')), 30000, 'Bob admitted')
    })

    await r.ok('Carol asks to join; Bob sees her request; Carol goes offline', async () => {
      await joinPending(C, code)
      await B.focus()
      await waitFor(async () => B.has({ role: 'button', name: 'Deny Carol' }), 60000, 'Bob sees Carol pending')
      await A.focus()
      await waitFor(async () => A.has({ role: 'button', name: 'Approve Carol' }), 30000, 'Alice sees Carol pending')
      await C.quit()
    })

    await r.ok('Alice approves Carol; Bob still shows the request', async () => {
      await A.click({ role: 'button', name: 'Approve Carol' })
      await waitFor(async () => !(await A.has({ role: 'button', name: 'Approve Carol' })), 20000, 'Alice\'s banner clears')
      await B.focus()
      assert(Date.now() - bobUp < HOLD_MS, 'precondition: Bob\'s membership fold has not run yet')
      assert(await B.has({ role: 'button', name: 'Deny Carol' }), 'precondition: Bob\'s banner still offers Deny Carol')
    })

    await r.ok('Bob denies Carol → a polite, sticky "already approved" warning; the banner clears', async () => {
      await B.click({ role: 'button', name: 'Deny Carol' })
      await waitFor(async () => B.hasText(WARNING), 20000, 'Bob sees the already-approved warning')
      const roles = rolesAbove(await B.snap(), WARNING) ?? []
      assert(!roles.includes('alert'), `the warning is not an assertive alert (${roles.join(' > ')})`)
      assert(roles.some((role) => /status/i.test(role)), `the warning sits in a status live region (${roles.join(' > ')})`)
      await waitFor(async () => !(await B.has({ role: 'button', name: 'Deny Carol' })), 20000, 'Bob\'s banner clears')
      await B.shot('s150-bob-warned', runDir)
      await sleep(6000)
      assert(await B.hasText(WARNING), 'the warning outlives the 5 s auto-dismiss')
    })
  } catch {}

  return { pass: r.summary(), instances: [A, B, C] }
}
