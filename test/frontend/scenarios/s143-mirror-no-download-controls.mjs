import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { findNode } from '../tree.mjs'
import { workDir } from '../paths.mjs'

// REGRESSION (FIX-325): a mirrored folder syncs itself, so its rows must not offer the per-file
// Download control a browse-only folder does. The same folder is opened twice on the same peer:
// first while browsing, where the control is the point of the screen, then after mirroring,
// where it must be gone — including right after the mount is created, when the mount listing is
// still catching up with the share listing.
export default async function s143({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const ownDir = path.join(workDir('own-'), 'Reports')
  const mirrorDir = workDir('mirror-')
  mkdirSync(ownDir, { recursive: true })
  writeFileSync(path.join(ownDir, 'q1.txt'), 'numbers')

  const downloadButton = async () => findNode(await B.snap(), { role: 'button', name: 'Download' })

  try {
    await r.ok('A shares "Reports"; B browses it and sees a Download control', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addOwnedFolder(ownDir)
      await B.waitText('Reports', 60000)
      await B.click({ name: 'Open Reports' })
      await B.waitText('q1.txt', 20000)
      await waitFor(async () => !!(await downloadButton()), 15000, 'browse row offers Download')
      await B.back()
    })
    await r.ok('B mirrors the folder and opens it: no row offers Download', async () => {
      await B.mirrorShare(mirrorDir)
      await B.click({ name: 'Open Reports' })
      await B.waitText('q1.txt', 20000)
      assert(!(await downloadButton()), 'no Download control on a mirrored row')
      await waitFor(
        async () => !!findNode(await B.snap(), { role: 'button', name: 'Reveal in Folder' }),
        60000, 'synced row offers Reveal in Folder',
      )
      assert(!(await downloadButton()), 'still none once the file has synced')
      await B.shot('s143-mirrored', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
