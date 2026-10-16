import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'
import { findNode } from '../tree.mjs'

// A native checkbox reaches the AX tree with its state as AXValue (0, 1, 2 for mixed) and, on some
// builds, as a state flag; either one answers. The node rides the failure message.
async function boxState(I, sel) {
  const node = findNode(await I.snap(), { ...sel, actionable: true })
  if (!node) return { state: 'missing', node: null }
  const states = node.states ?? []
  const state = node.value === '2' || states.includes('mixed') ? 'mixed' : node.value === '1' || states.includes('checked') ? 'on' : 'off'
  return { state, node }
}
async function assertBox(I, sel, want, msg) {
  let last = null
  await waitFor(async () => { last = await boxState(I, sel); return last.state === want }, 10000, msg).catch(() => {})
  assert(last && last.state === want, `${msg} (saw ${last?.state}: ${JSON.stringify(last?.node)})`)
}

// The selection column on a browse folder. At rest the only new control is the top box; its first
// tick opens the column with every matching file ticked. A row box unticks one and the top box
// reads mixed, the filter scopes select-all and names what it hides, Deselect hidden drops those,
// and Esc ends the selection with an announcement. Every box is a native checkbox with a name, so
// the AX tree is the proof.
const FILES = [
  'Contracts/Agreement-2026.pdf', 'Contracts/Invoice-0412.pdf', 'Contracts/Invoice-0413.pdf', 'Contracts/Invoice-0414.pdf',
  'Photos/raw/site-01.cr3', 'Photos/raw/site-02.cr3', 'Photos/site-01.jpg', 'Photos/site-02.jpg', 'Photos/site-03.jpg',
  'Floorplan-final.pdf', 'Handover-notes.md', 'Invoice-summary.xlsx', 'Walkthrough.mov',
]
const TOP = { role: 'checkbox', name: 'Select all 13 files' }

export default async function s174({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const ownDir = path.join(workDir('own-'), 'Handover')
  for (const rel of FILES) {
    const abs = path.join(ownDir, ...rel.split('/'))
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, rel)
  }

  try {
    await r.ok('at rest a browse folder shows the top box and no row boxes', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addOwnedFolder(ownDir)
      await B.waitText('Handover', 60000)
      await B.openFolder('Handover')
      await B.waitText('Floorplan-final.pdf', 30000)
      await waitFor(() => B.has(TOP), 20000, 'the top box exists')
      await assertBox(B, TOP, 'off', 'the top box is unticked at rest')
      assert(!(await B.has({ role: 'checkbox', name: 'Select Agreement-2026.pdf' })), 'no column at rest')
      await B.shot('s174-at-rest', runDir)
    })

    await r.ok('the first tick opens the column with every file ticked', async () => {
      await B.click(TOP)
      await B.waitText('13 selected', 20000)
      await assertBox(B, TOP, 'on', 'the top box is ticked')
      await waitFor(() => B.has({ role: 'checkbox', name: 'Select Invoice-0413.pdf' }), 20000, 'a row box exists')
      await assertBox(B, { role: 'checkbox', name: 'Select Invoice-0413.pdf' }, 'on', 'the row box is ticked')
      await B.shot('s174-selecting', runDir)
    })

    await r.ok('unticking one row makes the top box and its folder box read mixed', async () => {
      await B.click({ role: 'checkbox', name: 'Select Invoice-0413.pdf' })
      await B.waitText('12 selected', 20000)
      await assertBox(B, TOP, 'mixed', 'the top box reads mixed')
      await assertBox(B, { role: 'checkbox', name: 'Select all files in Contracts' }, 'mixed', 'the folder box reads mixed')
    })

    await r.ok('the filter scopes select-all to the matching files', async () => {
      await B.click({ role: 'button', name: 'Done' })
      await waitFor(async () => !(await B.has({ role: 'checkbox', name: 'Select Invoice-0413.pdf' })), 20000, 'the column closed')
      await B.type({ name: 'Filter files in this folder' }, 'invoice')
      await waitFor(() => B.has({ role: 'checkbox', name: 'Select all 4 matching files' }), 20000, 'the top box names the matches')
      await B.click({ role: 'checkbox', name: 'Select all 4 matching files' })
      await B.waitText('4 selected', 20000)
      assert(!(await B.hasText('hidden by the filter')), 'nothing is hidden')
    })

    await r.ok('a selection survives a filter change and names what the filter hides', async () => {
      await B.click({ role: 'button', name: 'Clear filter' })
      await waitFor(() => B.has({ role: 'checkbox', name: 'Select Floorplan-final.pdf' }), 20000, 'every row is back')
      await B.click({ role: 'checkbox', name: 'Select Floorplan-final.pdf' })
      await B.waitText('5 selected', 20000)
      await B.type({ name: 'Filter files in this folder' }, 'site')
      await B.waitText('hidden by the filter', 20000)
      await B.click({ role: 'button', name: 'Deselect hidden' })
      await waitFor(async () => !(await B.hasText('hidden by the filter')), 20000, 'the hidden rows were dropped')
      await B.click({ role: 'button', name: 'Clear filter' })
    })

    await r.ok('Esc ends the selection and announces it', async () => {
      await B.press('escape')
      await B.waitText('Selection ended', 20000)
      assert(!(await B.has({ role: 'checkbox', name: 'Select Floorplan-final.pdf' })), 'no row box remains')
      assert(await B.has(TOP), 'the top box stays')
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
