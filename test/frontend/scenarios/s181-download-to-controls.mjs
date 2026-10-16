import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

// The controls row's "Downloads to" button says where this space's downloads go and changes it. A
// pick there changes the folder and downloads nothing. It shows only where something can be
// downloaded — a browse folder, and the space screen when another member's file is listed — and
// hides while selecting, where the strip's split button names the folder. An own folder and a
// mirrored one have none.
export default async function s181({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const ownDir = path.join(workDir('own-'), 'Handover')
  mkdirSync(ownDir, { recursive: true })
  writeFileSync(path.join(ownDir, 'plan.pdf'), 'plan')
  writeFileSync(path.join(ownDir, 'notes.md'), 'notes')
  const looseDir = workDir('loose-')
  writeFileSync(path.join(looseDir, 'brief.txt'), 'brief')
  const clients = workDir('clients-')
  mkdirSync(clients, { recursive: true })
  const mirrorDir = workDir('mirror-')
  const anyButton = { role: 'combobox', contains: 'Downloads go to' }
  const named = (dir) => ({ name: `Downloads go to ${path.basename(dir)}, change` })

  try {
    await r.ok('the space screen shows it once another member\'s file is listed', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addOwnedFolder(ownDir)
      await A.addFile(path.join(looseDir, 'brief.txt'))
      await B.waitText('brief.txt', 60000)
      await waitFor(() => B.has(named(B.downloadFolder)), 20000, 'B\'s space screen names its folder')
      assert(!(await A.has(anyButton)), 'A lists only its own files: nothing to download, no button')
      await B.shot('s181-space', runDir)
    })

    await r.ok('on a browse folder a pick changes the folder and downloads nothing', async () => {
      await B.openFolder('Handover')
      await B.waitText('plan.pdf', 30000)
      await waitFor(() => B.has(named(B.downloadFolder)), 20000, 'the folder screen names it too')
      await B.setDownloadsTo({ path: clients })
      await B.waitText(`Downloads from Aurora now go to ${path.basename(clients)}`, 20000)
      await waitFor(() => B.has(named(clients)), 20000, 'the button names the new folder')
      await new Promise((res) => setTimeout(res, 1500))
      assert(readdirSync(clients).length === 0, 'nothing downloaded into the new folder')
      assert(!existsSync(path.join(B.downloadFolder, 'Handover')), 'nor into the old one')
      assert(await B.has({ name: 'plan.pdf: Available' }), 'the rows stay Available')
      await B.shot('s181-changed', runDir)
    })

    await r.ok('it hides while selecting and returns after Done', async () => {
      await B.click({ role: 'checkbox', name: 'Select all 2 files' })
      await B.waitText('2 selected', 20000)
      assert(!(await B.has(anyButton)), 'hidden while selecting')
      await B.click({ role: 'button', name: 'Done' })
      await waitFor(() => B.has(named(clients)), 20000, 'back after Done')
    })

    await r.ok('the owner\'s own folder has none', async () => {
      await A.openFolder('Handover')
      await A.waitText('plan.pdf', 30000)
      assert(!(await A.has(anyButton)), 'no button on an own folder')
    })

    await r.ok('a mirrored folder has none', async () => {
      await B.back()
      await B.waitText('Folders Shared', 20000)
      await B.mirrorShare(mirrorDir)
      await waitFor(() => existsSync(path.join(mirrorDir, 'plan.pdf')), 60000, 'the mirror synced')
      await B.openFolder('Handover')
      await B.waitText('plan.pdf', 30000)
      assert(!(await B.has(anyButton)), 'no button on a mirrored folder')
      await B.shot('s181-mirror', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
