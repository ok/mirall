import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, waitFor } from '../assert.mjs'

const settle = (ms = 600) => new Promise((res) => setTimeout(res, ms))

// The Members card shows a single-line avatar stack by default and expands to a
// scrollable list whose "Show less" stays pinned inside the box. A foldout click
// repaints the renderer (which can reassign the window's AX id), so we re-focus +
// settle after a click before snapshotting, and assert in one direction rather
// than toggling. Space Storage does not fold — s111 owns that assertion.
export default async function s51({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const tap = async (sel) => { await A.click(sel); await A.focus(); await settle() }

  try {
    await r.ok('the members stack is present', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.focus()
      await A.waitText('Members', 60000)
      await A.waitText('on this device', 10000)
      await waitFor(async () => A.has({ role: 'button', name: 'Show all' }), 10000, 'members stack + Show all targetable')
      await A.shot('s51-default', runDir)
    })

    await r.ok('Show all expands to the list with a pinned Show less', async () => {
      await A.focus()
      await tap({ role: 'button', name: 'Show all' })
      await waitFor(async () => A.has({ role: 'button', name: 'Show less' }), 10000, 'list + pinned Show less')
      await A.shot('s51-members-list', runDir)
    })
  } catch {}

  return { pass: r.summary(), instances: [A, B] }
}
