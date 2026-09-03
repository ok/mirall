import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { makeReport, waitFor, assert } from '../assert.mjs'
import { encodeInvite } from '../../../src/shared/invite-envelope.js'

// REGRESSION (r07-7 / defect 16): space:join throws INVITE_INVALID and INVITE_EXPIRED, and
// JoinSpaceModal displayed err.message — the worker's English — in every locale. An English run
// cannot see the bug, so this one switches to German first: the worker's strings appearing here
// IS the regression.
export default async function s128 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1 })

  try {
    await r.ok('switch the interface language to German', async () => {
      await A.launch()
      await A.gotoSettings('Appearance')
      await A.click({ name: 'Deutsch' })
      await A.waitText('Darstellung', 8000)
    })

    await r.ok('return to the spaces list', async () => {
      // Two levels up (section -> settings root -> list), and the control is German now.
      await waitFor(async () => {
        if (await A.hasText('Raum beitreten')) return true
        await A.click({ name: 'Zurück' })
        return false
      }, 15000, 'back on the spaces list')
    })

    await r.ok('a malformed invite code is rejected in German', async () => {
      await A.click({ role: 'button', name: 'Raum beitreten' })
      await A.waitText('Einladungscode', 8000)
      await A.type({ role: 'textfield', name: 'Einladungscode' }, 'not-a-real-code')
      await A.click({ role: 'button', name: 'Beitreten', last: true })
      await A.waitText('ungültig', 8000)
      assert(!(await A.hasText('Invalid invite code')), 'the worker English leaked into the German UI')
      await A.shot('s128-join-invalid-de', runDir)
    })

    await r.ok('an expired invite link is rejected in German', async () => {
      const expired = encodeInvite({ topic: 'a'.repeat(64), schemaVersion: 2, expiresAt: Date.now() - 120000 })
      await A.type({ role: 'textfield', name: 'Einladungscode' }, expired)
      await A.click({ role: 'button', name: 'Beitreten', last: true })
      await A.waitText('abgelaufen', 8000)
      assert(!(await A.hasText('This invite link has expired')), 'the worker English leaked into the German UI')
      await A.shot('s128-join-expired-de', runDir)
    })
  } catch {}

  return { pass: r.summary(), instances: [A] }
}
