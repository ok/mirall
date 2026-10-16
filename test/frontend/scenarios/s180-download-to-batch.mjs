import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

// The selection strip's Download is a split button. Its main half reads "Download 3" and "to
// <folder>", and its name is that label word for word ("Download 3 to <folder>"); its chevron opens the
// Download-to menu. A folder picked there takes the whole batch, keeps the files' subfolders, becomes
// the space's folder and says so in one toast; the controls-row button names it once the
// selection ends. There is no Cancel N beside it.
const FILES = ['Contracts/Agreement.pdf', 'Contracts/Invoice.pdf', 'Floorplan.pdf']

export default async function s180({ runDir, bootstrap }) {
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
  const press = workDir('press-')
  mkdirSync(press, { recursive: true })
  const dl = () => path.basename(B.downloadFolder)

  try {
    await r.ok('selecting three files offers "Download 3" to the space\'s folder, and no Cancel', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addOwnedFolder(ownDir)
      await B.waitText('Handover', 60000)
      await B.openFolder('Handover')
      await waitFor(() => B.has({ role: 'checkbox', name: 'Select all 3 files' }), 60000, 'all three files listed')
      await B.click({ role: 'checkbox', name: 'Select all 3 files' })
      await B.waitText('3 selected', 20000)
      await waitFor(() => B.has({ role: 'button', name: `Download 3 to ${dl()}` }), 10000, 'the main half names the count and the folder')
      assert(await B.has({ role: 'group', name: 'Download' }), 'the two halves are one group')
      assert(await B.hasText('Download 3'), 'the main half reads the count')
      assert(await B.hasText(`to ${dl()}`), 'and the folder')
      assert(await B.has({ name: 'More download options' }), 'the chevron half is there')
      assert(!(await B.has({ role: 'button', contains: 'Cancel 3' })), 'no Cancel N')
      assert(!(await B.has({ role: 'combobox', contains: 'Downloads go to' })), 'the controls-row button hides while selecting')
      await B.shot('s180-strip', runDir)
    })

    await r.ok('the chevron\'s menu sends the batch to another folder, with its subfolders', async () => {
      await B.downloadSelected(3, { path: press })
      await waitFor(() => FILES.every((rel) => existsSync(path.join(press, 'Handover', ...rel.split('/')))), 120000, 'every file landed in <press>/Handover')
      assert(FILES.every((rel) => !existsSync(path.join(B.downloadFolder, 'Handover', ...rel.split('/')))), 'nothing landed in the old folder')
      await B.waitText(`Downloads from Aurora now go to ${path.basename(press)}`, 20000)
    })

    await r.ok('the selection ends, and the controls-row button names the new folder', async () => {
      await waitFor(async () => !(await B.hasText('3 selected')), 20000, 'the selection ended')
      await waitFor(() => B.has({ name: `Downloads go to ${path.basename(press)}, change` }), 20000, 'the button follows the batch')
      await B.waitText('On your device', 30000)
      await B.shot('s180-after', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
