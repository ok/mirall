import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { makeReport, waitFor } from '../assert.mjs'

const settle = (ms = 600) => new Promise((res) => setTimeout(res, ms))

// The SpaceView sidebar cards (Space Storage, Members) keep their fold — and the
// Members card its stack-vs-list choice — per space for the session, so leaving a
// space and coming back restores what you left. The two states are independent: a
// collapsed Members card still holds an expanded list underneath. A second space
// keeps its own defaults, which is what makes this per-space rather than global.
// Foldout and navigation clicks repaint the renderer (which can reassign the window's
// AX id), so re-focus + settle after each one before asserting.
export default async function s111 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1 })

  const tap = async (sel) => { await A.click(sel); await A.focus(); await settle() }
  const openSpace = async (name) => { await tap({ name: `Open ${name}` }); await A.waitText('Members', 30000) }
  const leaveSpace = async () => { await A.back(); await A.focus(); await settle() }

  const storageOpen = () => A.hasText('on this device')
  const membersListShown = () => A.has({ role: 'button', name: 'Show less' })
  const membersStackShown = () => A.has({ role: 'button', name: 'Show all' })

  try {
    await r.ok('a fresh space opens with the default card state', async () => {
      await A.launch()
      await A.createSpaceOnly('Aurora')
      await A.focus()
      await A.waitText('Members', 60000)
      await waitFor(storageOpen, 20000, 'storage card open by default')
      await waitFor(membersStackShown, 20000, 'members show the avatar stack by default')
      await A.shot('s111-defaults', runDir)
    })

    await r.ok('collapsing Storage and expanding Members changes both', async () => {
      await tap({ role: 'button', name: 'Space Storage' })
      await waitFor(async () => !(await storageOpen()), 20000, 'storage collapsed')
      await tap({ role: 'button', name: 'Show all' })
      await waitFor(membersListShown, 20000, 'members expanded to the list')
      await A.shot('s111-changed', runDir)
    })

    await r.ok('leaving the space and coming back restores both', async () => {
      await leaveSpace()
      await openSpace('Aurora')
      await waitFor(async () => !(await storageOpen()), 20000, 'storage still collapsed')
      await waitFor(membersListShown, 20000, 'members still expanded')
      await A.shot('s111-restored', runDir)
    })

    await r.ok('a second space keeps its own defaults', async () => {
      await leaveSpace()
      await A.createSpaceOnly('Borealis')
      await A.focus()
      await A.waitText('Members', 30000)
      await waitFor(storageOpen, 20000, 'Borealis storage open by default')
      await waitFor(membersStackShown, 20000, 'Borealis members show the stack by default')
      await A.shot('s111-second-space', runDir)
    })

    await r.ok('the first space still restores after visiting the second', async () => {
      await leaveSpace()
      await openSpace('Aurora')
      await waitFor(async () => !(await storageOpen()), 20000, 'Aurora storage still collapsed')
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
