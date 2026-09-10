import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { makeReport, waitFor, assert } from '../assert.mjs'
import { allText, findNode } from '../tree.mjs'
import { workDir } from '../paths.mjs'

// REGRESSION (FIX-D8 / FIX-D9): the two confirm dialogs whose busy flag gates every exit.
//
// FIX-D8 — RemoveFileModal held `removing` true forever when the removal rejected, so Escape and
// the backdrop were refused while the header ✕ stayed live: the only way out was the one click the
// busy flag claimed was unsafe. FIX-D9 — LeaveSpaceModal completed from a `finally`, painting the
// bar to 100% and navigating away from a space the user was still in.
//
// The rejection itself is not reachable from the UI: `space:leave` answers ok even when its
// teardown throws, and the only other rejection source — the worker dying — reloads the renderer.
// The shape of both fixes is pinned at the unit layer (test/unit/modal-busy-recovery.test.js);
// what this scenario holds is the property a person experiences: each dialog keeps a named,
// reachable way out when it is not busy, exposes no live close button while it is, and its
// happy path still lands.
export default async function s140 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1 })

  const file = path.join(workDir('modalexit-'), 'draft.txt')
  writeFileSync(file, 'a file the remove confirm must let go of')

  async function openRemoveConfirm() {
    await A.click({ role: 'button', name: 'Unshare from Space', last: true })
    await A.waitText('Remove File', 8000)
  }

  async function openLeaveConfirm() {
    await A.click({ name: 'More' })
    await new Promise((res) => setTimeout(res, 400))
    await A.click({ name: 'Leave Space' })
    // The dialog's body, not its title: the menu item that opened it is named "Leave Space" too.
    await A.waitText('stop syncing with members', 8000)
  }

  try {
    await r.ok('launch, create a space, share a file', async () => {
      await A.launch()
      await A.createSpaceOnly('Aurora')
      await A.addFile(file)
      await A.waitText('draft.txt', 30000)
    })

    await r.ok('the remove confirm carries a named close button and answers Escape', async () => {
      await openRemoveConfirm()
      assert(await A.has({ role: 'button', name: 'Close' }), 'the confirm exposes a close button by name')
      assert(!(await A.isDisabled({ role: 'button', name: 'Close' })), 'and it is live while nothing is running')
      await A.press('escape')
      await waitFor(async () => !(await A.hasText('Remove File')), 8000, 'the confirm to close on Escape')
      assert(await A.hasText('draft.txt'), 'the file survived the dismissal')
    })

    await r.ok('and the close button itself dismisses it', async () => {
      await openRemoveConfirm()
      await A.click({ role: 'button', name: 'Close' })
      await waitFor(async () => !(await A.hasText('Remove File')), 8000, 'the confirm to close on ✕')
      assert(await A.hasText('draft.txt'), 'the file survived the dismissal')
      await A.shot('s140-remove-dismissed', runDir)
    })

    await r.ok('the remove still removes', async () => {
      await openRemoveConfirm()
      await A.click({ role: 'button', name: 'Remove File', last: true })
      await waitFor(async () => !(await A.hasText('draft.txt')), 15000, 'the file to go')
    })

    await r.ok('the leave confirm answers Escape before it is busy', async () => {
      await openLeaveConfirm()
      assert(await A.has({ role: 'button', name: 'Close' }), 'the leave confirm exposes a close button by name')
      await A.press('escape')
      await waitFor(async () => !(await A.hasText('stop syncing with members')), 8000, 'the leave confirm to close on Escape')
      assert(await A.hasText('Aurora'), 'still in the space')
      await A.shot('s140-leave-dismissed', runDir)
    })

    await r.ok('leaving reports progress with no live close button, and lands on the list', async () => {
      await openLeaveConfirm()
      await A.click({ role: 'button', name: 'Leave Space', last: true })
      let sawProgress = false
      await waitFor(async () => {
        const tree = await A.snap()
        const text = allText(tree)
        // The progress step is undismissable by design; a close button there would be the one exit
        // the busy state refuses everywhere else.
        if (text.includes('Leaving...')) {
          sawProgress = true
          assert(!findNode(tree, { role: 'button', name: 'Close' }), 'no close button on the progress step')
        }
        return text.includes('Create Space')
      }, 60000, 'the leave to finish and land on the spaces list')
      // A solo space can tear down faster than one snapshot round trip, so seeing the progress
      // step is an observation, not a precondition.
      console.error(sawProgress ? 'observed the leave progress step' : 'leave completed before a snapshot caught the progress step')
      assert(!(await A.hasText('Aurora')), 'the space is gone from the list')
      await A.shot('s140-left', runDir)
    })
  } catch {}

  return { pass: r.summary(), instances: [A] }
}
