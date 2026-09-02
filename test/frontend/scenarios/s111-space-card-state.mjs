import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { makeReport, waitFor } from '../assert.mjs'

const settle = (ms = 600) => new Promise((res) => setTimeout(res, ms))

// The Members card keeps its fold — and its stack-vs-list choice — per space for the
// session, so leaving a space and coming back restores what you left. The two states are
// independent: a collapsed Members card still holds an expanded list underneath. A second
// space keeps its own defaults, which is what makes this per-space rather than global.
//
// Space Storage does NOT fold, and that is asserted rather than assumed: only the people
// tile folds on either screen, because the folder screen's size tile can't (its top-right
// corner carries the status badge). It used to fold and keep that fold here, so the guard
// is against the fold coming back rather than against it never having existed.
//
// Foldout and navigation clicks repaint the renderer (which can reassign the window's
// AX id), so re-focus + settle after each one before asserting.
export default async function s111 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1 })

  const tap = async (sel) => { await A.click(sel); await A.focus(); await settle() }
  const openSpace = async (name) => { await tap({ name: `Open ${name}` }); await A.waitText('Members', 30000) }
  const leaveSpace = async () => { await A.back(); await A.focus(); await settle() }

  const storageShown = () => A.hasText('on this device')
  const storageFoldable = () => A.has({ role: 'button', name: 'Space Storage' })
  const membersListShown = () => A.has({ role: 'button', name: 'Show less' })
  const membersStackShown = () => A.has({ role: 'button', name: 'Show all' })

  try {
    await r.ok('a fresh space opens with the default card state', async () => {
      await A.launch()
      await A.createSpaceOnly('Aurora')
      await A.focus()
      await A.waitText('Members', 60000)
      await waitFor(storageShown, 20000, 'storage figure on screen')
      await waitFor(membersStackShown, 20000, 'members show the avatar stack by default')
      if (await storageFoldable()) throw new Error('Space Storage is collapsible again')
      await A.shot('s111-defaults', runDir)
    })

    await r.ok('expanding Members changes it, and Storage stays put', async () => {
      await tap({ role: 'button', name: 'Show all' })
      await waitFor(membersListShown, 20000, 'members expanded to the list')
      await waitFor(storageShown, 20000, 'storage figure unaffected by the Members expand')
      await A.shot('s111-changed', runDir)
    })

    await r.ok('leaving the space and coming back restores both', async () => {
      await leaveSpace()
      await openSpace('Aurora')
      await waitFor(membersListShown, 20000, 'members still expanded')
      await waitFor(storageShown, 20000, 'storage figure still on screen')
      await A.shot('s111-restored', runDir)
    })

    await r.ok('a second space keeps its own defaults', async () => {
      await leaveSpace()
      await A.createSpaceOnly('Borealis')
      await A.focus()
      await A.waitText('Members', 30000)
      await waitFor(membersStackShown, 20000, 'Borealis members show the stack by default')
      await waitFor(storageShown, 20000, 'Borealis storage figure on screen')
      await A.shot('s111-second-space', runDir)
    })

    await r.ok('the first space still restores after visiting the second', async () => {
      await leaveSpace()
      await openSpace('Aurora')
      await waitFor(membersListShown, 20000, 'Aurora members still expanded')
      await A.shot('s111-back-to-first', runDir)
    })

    await r.ok('a collapsed Members card restores collapsed, still holding its list', async () => {
      await tap({ role: 'button', contains: 'Members' })
      await waitFor(async () => !(await membersListShown()), 20000, 'members card collapsed')
      await leaveSpace()
      await openSpace('Aurora')
      await waitFor(async () => !(await membersListShown()) && !(await membersStackShown()),
        20000, 'members card still collapsed')
      await tap({ role: 'button', contains: 'Members' })
      await waitFor(membersListShown, 20000, 'reopening reveals the list it was holding')
      await A.shot('s111-members-collapsed', runDir)
    })
  } catch {}

  return { pass: r.summary(), instances: [A] }
}
