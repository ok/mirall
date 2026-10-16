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

// The accelerators of the selection column, driven as a user's pointer and keys: a command-click
// on a row body at rest opens the column with that row alone, a shift-click selects the range
// between the anchor and the target including a collapsed folder's files, a command-click on a
// folder row selects its files without expanding it, and select-all takes everything from a row
// but keeps selecting text inside the filter. Modified clicks and the chord reach the page as
// synthetic input, which is what the harness's background mode delivers.
const FILES = [
  'Contracts/Agreement-2026.pdf', 'Contracts/Invoice-0412.pdf', 'Contracts/Invoice-0413.pdf',
  'Photos/raw/site-01.cr3', 'Photos/raw/site-02.cr3', 'Photos/site-01.jpg',
  'Floorplan-final.pdf', 'Handover-notes.md',
]
// Rows have no control of their own; the row body is hit by way of its Download button, well left
// of it, where the name and the status pill sit.
const ROW_BODY = { dx: -260 }

export default async function s177({ runDir, bootstrap }) {
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
    await r.ok('a command-click on a row body at rest opens the column with that row alone', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addOwnedFolder(ownDir)
      await B.waitText('Handover', 60000)
      await B.openFolder('Handover')
      await B.waitText('Floorplan-final.pdf', 30000)
      // The first Download button belongs to the first file row, Contracts/Agreement-2026.pdf.
      await B.modifierClick({ role: 'button', name: 'Download' }, ['meta'], ROW_BODY)
      await B.waitText('1 selected', 20000)
      await assertBox(B, { role: 'checkbox', name: 'Select Agreement-2026.pdf' }, 'on', 'that row is ticked')
      await B.shot('s177-mod-click', runDir)
    })

    await r.ok('a shift-click selects the range, including the files of a collapsed folder in between', async () => {
      // The last Download button is Handover-notes.md, the last row; raw/ sits collapsed in between.
      // With the column open that row sits below the fold, so it is scrolled to before the click.
      await B.main.scrollIntoView('[data-select-key="Handover-notes.md"]')
      await B.modifierClick({ role: 'button', name: 'Download', last: true }, ['shift'], ROW_BODY)
      await B.waitText('8 selected', 20000)
      await assertBox(B, { role: 'checkbox', name: 'Select all files in raw' }, 'on', 'the collapsed folder\'s files are in the range')
      await B.shot('s177-shift-range', runDir)
    })

    await r.ok('a command-click on a folder row toggles its files without expanding it', async () => {
      await B.main.scrollIntoView('button[aria-label="Photos"]')
      const expanded = await B.nodeValue({ role: 'button', name: 'Photos' })
      await B.modifierClick({ role: 'button', name: 'Photos' }, ['meta'])
      await B.waitText('5 selected', 20000)
      assert(await B.nodeValue({ role: 'button', name: 'Photos' }) === expanded, 'the folder did not expand or collapse')
    })

    await r.ok('select-all from a row takes everything; inside the filter it leaves the selection alone', async () => {
      await B.pressKeys('cmd+a')
      await B.waitText('8 selected', 20000)
      await B.click({ role: 'checkbox', name: 'Select Floorplan-final.pdf' })
      await B.waitText('7 selected', 20000)
      await B.click({ name: 'Filter files in this folder' })
      await B.type({ name: 'Filter files in this folder' }, 'site')
      await B.pressKeys('cmd+a')
      await waitFor(() => B.hasText('7 selected'), 5000, 'the count is unchanged')
      assert(!(await B.hasText('8 selected')), 'the chord inside the filter selected text, not files')
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
