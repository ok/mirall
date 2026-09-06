import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { makeReport, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

// The dialog keyboard contract, end to end (the decision itself is unit-tested in
// test/unit/modal-keys.test.js). Every dialog used to answer Enter differently: only the modals
// that wired onConfirm heard Cmd/Ctrl+Enter at all, five bound their own field, and in the rest
// FocusScope's autoFocus put focus on the header ✕ — so Enter quietly closed the dialog instead
// of confirming it. s3 covers plain Enter inside a text field; this covers the other four cases.
export default async function s133 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1 })

  const file = path.join(workDir('modalkeys-'), 'keeper.txt')
  writeFileSync(file, 'a file the Enter key must not remove')

  try {
    await r.ok('launch', async () => {
      await A.launch()
    })
    await r.ok('Escape dismisses a dialog', async () => {
      await A.press('cmd+n')
      await A.waitText('Create a New Space', 8000)
      await A.press('escape')
      await waitFor(async () => !(await A.hasText('Create a New Space')), 8000, 'the create dialog to close')
    })
    await r.ok('Cmd+Enter submits from inside the name field, once', async () => {
      // REGRESSION (FIX-MODAL-1): the field bound Enter without checking the modifier, so this
      // chord ran the field handler AND the modal's confirm in one dispatch — two spaces.
      await A.press('cmd+n')
      await A.waitText('Create a New Space', 8000)
      await A.type({ role: 'textfield' }, 'Aurora')
      // set-value leaves DOM focus wherever it was; put it in the field so the chord is delivered
      // the way it is for a person typing there.
      await A.click({ role: 'textfield' })
      await A.press('cmd+return')
      await A.waitText('Space Created', 15000)
      await A.click({ role: 'button', name: 'Done' })
      await A.waitText('Aurora', 8000)
    })
    await r.ok('Enter reaches the primary action in a dialog with no text field', async () => {
      // REGRESSION (FIX-MODAL-2): nothing here claims focus, so it used to land on the header ✕
      // and Enter closed the dialog. The panel holds it now, and Enter means "create the link".
      await A.openInviteModal()
      await A.press('return')
      await A.waitText('Invite link ready', 20000)
      await A.shot('s133-invite-by-enter', runDir)
      await A.press('escape')
    })
    await r.ok('Enter never fires a destructive confirm', async () => {
      await A.addFile(file)
      await A.waitText('keeper.txt', 30000)
      await A.click({ role: 'button', name: 'Unshare from Space', last: true })
      await A.waitText('Remove File', 8000)
      await A.press('return')
      // The confirm is an alertdialog resting on Cancel, so Enter dismisses it. What it must never
      // do — with or without a modifier — is remove the file.
      await waitFor(async () => !(await A.hasText('Remove File')), 8000, 'the confirm to close')
      await waitFor(async () => A.hasText('keeper.txt'), 8000, 'the file to survive the keypress')
      await A.shot('s133-file-survived', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
