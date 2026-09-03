import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { makeReport, waitFor } from '../assert.mjs'
import { encodeInvite } from '../../../src/shared/invite-envelope.js'

// JoinSpaceModal validation: the Join action is disabled with no code, and a
// malformed invite code is rejected with an inline error. The text is the worker's
// code rendered through the errors catalog, not its English message — s126 pins that
// in a non-English locale, where the difference is visible. The code field, Join
// button (disabled state), and the role=alert error region must be addressable.
// Pressing Enter in the auto-focused code field submits the join just like
// clicking Join — without the field's keydown handler the keypress is swallowed
// (the modal only confirms on Cmd/Ctrl+Enter) and no error ever returns.
export default async function s3 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1 })

  try {
    await r.ok('launch + open Join modal', async () => {
      await A.launch()
      await A.openJoinModal()
    })
    await r.ok('Join is disabled until a code is entered', async () => {
      await waitFor(async () => A.isDisabled({ role: 'button', name: 'Join Space', last: true }), 8000, 'Join disabled when empty')
    })
    await r.ok('a malformed invite code is rejected with an inline error', async () => {
      await A.type({ role: 'textfield', name: 'Invite Code' }, 'not-a-real-code')
      await A.click({ role: 'button', name: 'Join Space', last: true })
      await A.waitText('not valid', 8000)
      await A.shot('s3-invalid', runDir)
    })
    await r.ok('pressing Enter in the code field submits the join (same inline error)', async () => {
      // Re-typing clears the prior inline error (onChange resets it), so the
      // error reappearing proves the Enter keypress alone re-ran the join.
      await A.type({ role: 'textfield', name: 'Invite Code' }, 'still-not-a-code')
      // Focus the field itself before pressing Enter: set-value leaves DOM focus
      // on the previously-clicked Join button, so the keypress must land in the
      // code field (as it does for a real user typing there) to exercise its
      // keydown handler.
      await A.click({ role: 'textfield', name: 'Invite Code' })
      await A.press('return')
      await A.waitText('not valid', 8000)
    })
    await r.ok('an expired invite link is rejected with an inline error', async () => {
      // Past the 60s joiner-side grace → the local pre-check refuses it (no peer needed). Type the
      // bare envelope: the field's onChange peels a mirall://join/ prefix, which would otherwise
      // make agent-desktop's set-value verify mismatch.
      const expired = encodeInvite({ topic: 'a'.repeat(64), schemaVersion: 2, expiresAt: Date.now() - 120000 })
      await A.type({ role: 'textfield', name: 'Invite Code' }, expired)
      await A.click({ role: 'button', name: 'Join Space', last: true })
      await A.waitText('expired', 8000)
      await A.shot('s3-expired', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
