import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, waitFor, assert } from '../assert.mjs'
import { flatten } from '../tree.mjs'
import { workDir } from '../paths.mjs'

// Loose files on the space route (FileCard): a downloaded+verified file and a
// still-remote file coexist in the list. The "verified" badge is information, so
// it sits just left of the status pill, leaving the row's right edge for actions;
// the action cluster stays a constant-width two-slot strip so the status pills
// line up across rows. Pixel geometry isn't observable through the AX tree, but
// DOM order is — so this asserts the arrangement (verified badge BEFORE the pill
// BEFORE the actions) plus the a11y outcome that every control is reachable by
// accessible name.
export default async function s69 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const dir = workDir('loose-')
  const f1 = path.join(dir, 'report.txt')
  const f2 = path.join(dir, 'notes.txt')
  mkdirSync(dir, { recursive: true })
  writeFileSync(f1, 'first loose file contents')
  writeFileSync(f2, 'second loose file contents')

  try {
    await r.ok('launch + connect', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
    })
    await r.ok('A shares the first loose file; B downloads it (verified badge appears)', async () => {
      await A.addFile(f1)
      await B.waitText('report.txt', 60000)
      await B.click({ role: 'button', name: 'Download', last: true })
      await B.waitText('On your device', 60000)
      await waitFor(() => B.has({ contains: 'content hash matches' }), 30000,
        'verified badge rendered + accessibly named on the downloaded row')
    })
    await r.ok('A shares a second loose file; B sees it as still-remote', async () => {
      await A.addFile(f2)
      await B.waitText('notes.txt', 60000)
      await B.waitText('Available', 60000)
    })
    await r.ok('both rows keep their controls: verified + Reveal on the downloaded row, Download on the remote row', async () => {
      await waitFor(() => B.has({ contains: 'content hash matches' }), 10000, 'verified badge still reachable')
      await waitFor(() => B.has({ role: 'button', name: 'Reveal in Folder' }), 10000, 'reveal on the downloaded row')
      await waitFor(() => B.has({ role: 'button', name: 'Download' }), 10000, 'download still on the remote row')
      await B.shot('s69-B-mixed-rows', runDir)
    })
    await r.ok('layout: verified badge is left of the status pill, with the action on the right', async () => {
      const nodes = flatten(await B.snap())
      // Match across name/description/value: the pill text surfaces as statictext
      // (value), the badge name as aria-label (description), the button as name.
      const text = (n) => `${n.name} ${n.description} ${n.value}`.toLowerCase()
      const vIdx = nodes.findIndex((n) => text(n).includes('content hash matches'))
      const pIdx = nodes.findIndex((n) => text(n).includes('on your device'))
      const aIdx = nodes.findIndex((n) => n.role === 'button' && text(n).includes('reveal in folder'))
      assert(vIdx >= 0, 'verified badge present in the AX tree')
      assert(pIdx >= 0, '"On your device" pill present')
      assert(aIdx >= 0, 'reveal action present')
      assert(vIdx < pIdx, `verified badge (${vIdx}) is before the status pill (${pIdx})`)
      assert(pIdx < aIdx, `status pill (${pIdx}) is before the reveal action (${aIdx}) — actions on the right`)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
