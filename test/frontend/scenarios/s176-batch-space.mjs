import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

// The space screen's filter and batch. The filter narrows the loose files and says by how much;
// the top box hides Folders Shared and offers one verb per bucket; Unshare confirms in an alert
// dialog and reports a toast, and the peer loses the rows; a one-file batch shows the pinned strip
// that Cancel All clears; leaving the space drops the selection. Alice's worker reads a download
// cap from the settings file written beside its store, so the strip is on screen long enough to
// cancel.
const FILTER = { name: 'Filter files in this space' }
const TOP = { role: 'checkbox', name: 'Select all 4 files' }

export default async function s176({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })
  mkdirSync(A.store, { recursive: true })
  writeFileSync(path.join(A.store, 'settings.json'), JSON.stringify({ network: { downloadKBps: 4096 } }))

  const aDir = workDir('a-files-')
  const bDir = workDir('b-files-')
  writeFileSync(path.join(aDir, 'Budget-2026.xlsx'), 'budget')
  writeFileSync(path.join(aDir, 'Site-photos.zip'), 'photos')
  writeFileSync(path.join(bDir, 'Brief-v3.pdf'), 'brief')
  writeFileSync(path.join(bDir, 'Kickoff.mp4'), Buffer.alloc(40 * 1024 * 1024, 5))
  const folder = path.join(workDir('own-'), 'Assets')
  mkdirSync(folder, { recursive: true })
  writeFileSync(path.join(folder, 'logo.svg'), '<svg/>')

  try {
    await r.ok('at rest the space shows its folders and a filter', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addFiles([path.join(aDir, 'Budget-2026.xlsx'), path.join(aDir, 'Site-photos.zip')])
      await B.addFiles([path.join(bDir, 'Brief-v3.pdf'), path.join(bDir, 'Kickoff.mp4')])
      await B.addOwnedFolder(folder)
      await A.waitText('Folders Shared', 60000)
      await A.waitText('Kickoff.mp4', 60000)
      await waitFor(() => A.has(TOP), 30000, 'all four files are listed and the top box names them')
      assert(await A.has(FILTER), 'the filter field exists')
      await A.shot('s176-at-rest', runDir)
    })

    await r.ok('the filter narrows the files and says by how much', async () => {
      await A.type(FILTER, 'brief')
      await A.waitText('1 of 4', 20000)
      assert(await A.hasText('Brief-v3.pdf'), 'the match is listed')
      assert(!(await A.hasText('Budget-2026.xlsx')), 'the rest are not')
      await A.click({ role: 'button', name: 'Clear filter' })
      await A.waitText('Budget-2026.xlsx', 20000)
    })

    await r.ok('the top box hides the folders and offers Download and Unshare counts', async () => {
      await A.click(TOP)
      await A.waitText('4 selected', 20000)
      await waitFor(async () => !(await A.hasText('Folders Shared')), 20000, 'the folders section left the list')
      assert(await A.has({ role: 'button', name: 'Download 2' }), 'Download counts the two peer files')
      assert(await A.has({ role: 'button', name: 'Unshare 2' }), 'Unshare counts the two own files')
      assert(!(await A.has({ role: 'button', name: 'Cancel 2' })), 'nothing to cancel')
      await A.shot('s176-selecting', runDir)
    })

    await r.ok('Unshare confirms, reports a toast, and the peer loses the files', async () => {
      await A.click({ role: 'button', name: 'Unshare 2' })
      await A.waitText('Unshare 2 files?', 20000)
      await A.click({ role: 'button', name: 'Cancel' })
      await waitFor(async () => !(await A.hasText('Unshare 2 files?')), 20000, 'the dialog closed')
      assert(await A.hasText('Budget-2026.xlsx'), 'cancel kept the rows')
      await A.click({ role: 'button', name: 'Unshare 2' })
      await A.waitText('Unshare 2 files?', 20000)
      await A.click({ role: 'button', name: 'Unshare 2 Files' })
      await A.waitText('2 files unshared', 30000)
      await waitFor(async () => !(await A.hasText('Budget-2026.xlsx')), 30000, 'the rows are gone')
      await A.waitText('Folders Shared', 20000)
      await waitFor(async () => !(await B.hasText('Budget-2026.xlsx')), 60000, 'the peer lost the files')
    })

    await r.ok('a one-file batch shows the pinned strip, and Cancel All clears it', async () => {
      await A.click({ role: 'checkbox', name: 'Select all 2 files' })
      await A.waitText('2 selected', 20000)
      await A.click({ role: 'checkbox', name: 'Select Brief-v3.pdf' })
      await A.waitText('1 selected', 20000)
      await A.click({ role: 'button', name: 'Download 1' })
      await A.waitText('Downloading 1 file', 20000)
      await waitFor(() => A.has({ role: 'progressbar', name: 'Batch download progress' }), 20000, 'the batch progressbar')
      await A.shot('s176-batch', runDir)
      await A.click({ role: 'button', name: 'Cancel All' })
      await waitFor(async () => !(await A.hasText('Downloading 1 file')), 20000, 'the strip is gone')
      await A.waitText('Available', 20000)
    })

    await r.ok('leaving the space and coming back drops the selection', async () => {
      await A.click({ role: 'checkbox', name: 'Select all 2 files' })
      await A.waitText('2 selected', 20000)
      await A.back()
      await A.click({ name: 'Open Aurora' })
      await A.waitText('Files Shared', 20000)
      assert(!(await A.hasText('2 selected')), 'no selection survives the trip')
      assert(!(await A.has({ role: 'checkbox', name: 'Select Brief-v3.pdf' })), 'the column is closed')
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
