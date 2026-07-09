import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { createSpaceWithInvite, joinPending } from '../helpers.mjs'
import { makeReport, waitFor } from '../assert.mjs'

const settle = (ms = 600) => new Promise((res) => setTimeout(res, ms))

// Three flows: (1) deny — A rejects Bob's join request and Bob is told he was declined;
// (2) REGRESSION — Bob's decline toast is sticky (duration:0); hovering it and moving
// away must NOT auto-dismiss it (a hover/blur used to re-arm a 1s timer on sticky toasts);
// (3) the invite modal's "Auto-approve new members" toggle is present, off by default,
// and togglable. Exercises the deny path, sticky-toast persistence, and the InviteModal
// toggle component. Local-only (real Electron + AX).
export default async function s56 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  try {
    await r.ok('A denies Bob; Bob is told the request was declined', async () => {
      await A.launch()
      await B.launch()
      const code = await createSpaceWithInvite(A, { name: 'Aurora' })
      await joinPending(B, code)

      // SECURITY/UX: while pending Bob is NOT a member — he must see no member-only
      // controls (Invite/Edit), only a way to withdraw.
      if (await B.has({ role: 'button', name: 'Invite' })) throw new Error('pending joiner must not see Invite')
      await waitFor(async () => B.has({ role: 'button', name: 'Cancel request' }), 10000, 'pending joiner can withdraw')

      await A.focus()
      await A.waitText('wants to join', 30000)
      await waitFor(async () => A.has({ role: 'button', name: 'Deny Bob' }), 10000, 'Deny Bob targetable')
      await A.click({ role: 'button', name: 'Deny Bob' })
      await waitFor(async () => B.hasText('declined'), 30000, 'Bob sees the request was declined')
      // REGRESSION: a denied joiner never joined — the pending space is dropped from
      // his view automatically (he isn't forced to "leave" a space he never joined).
      await waitFor(async () => !(await B.hasText('Waiting to be let in')), 15000, 'denied pending space auto-cleared')
      await B.shot('s56-denied', runDir)
    })

    await r.ok('the decline toast is sticky — hovering it does not auto-dismiss it', async () => {
      await B.focus()
      if (!(await B.hasText('declined'))) throw new Error('precondition: decline toast not present')
      // Hover the toast (cursor onto its Dismiss control), then move the cursor off it.
      // Pre-fix, that mouseleave re-armed a 1s dismiss even though duration is 0.
      await B.hover({ role: 'button', name: 'Dismiss' })
      await B.moveCursorAway()
      await settle(2200) // > MIN_RESUME_DURATION (1000ms) + leave transition, with margin
      if (!(await B.hasText('declined'))) {
        throw new Error('sticky toast auto-dismissed after hover — duration:0 not honored on resume')
      }
      await B.shot('s56-sticky-survives-hover', runDir)
    })

    await r.ok('the invite modal offers an Auto-approve toggle, off by default and togglable', async () => {
      await A.focus()
      await A.back()
      await A.waitText('Create Space', 10000)
      await A.createSpaceOnly('Beta')
      await A.openInviteModal()
      const toggle = { name: 'Auto-approve' }
      await waitFor(async () => A.has(toggle), 10000, 'Auto-approve toggle present')
      const before = await A.nodeValue(toggle)
      if (before !== '0') throw new Error('Auto-approve should default to off (got ' + before + ')')
      // The configure step exposes the expiry presets and reveals no link until Create. The presets
      // are aria-pressed segmented pills — target by name only (role:button doesn't match them).
      for (const name of ['2 hours', '2 days', '2 weeks']) {
        await waitFor(async () => A.has({ name }), 8000, `expiry preset ${name} present`)
      }
      if (await A.has({ role: 'button', name: 'Copy' })) throw new Error('no link before Create')
      await A.shot('s56-invite-toggle-off', runDir)
      await A.click(toggle)
      await waitFor(async () => (await A.nodeValue(toggle)) === '1', 10000, 'toggle turns on')
      await A.shot('s56-invite-toggle-on', runDir)
    })
  } catch {}

  return { pass: r.summary(), instances: [A, B] }
}
