import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

// Per-space download folder. The contract the user cares about: switching folders never
// moves or deletes a file, a copy outside the new folder reads as not-downloaded, and
// switching back restores it. Changes apply on Save, so closing the modal discards them.
export default async function s107 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const ownDir = path.join(workDir('own-'), 'Archive')
  mkdirSync(ownDir, { recursive: true })
  writeFileSync(path.join(ownDir, 'notes.txt'), 'shared notes')

  const spaceDl = workDir('space-dl-')
  mkdirSync(spaceDl, { recursive: true })
  const otherDl = workDir('other-dl-')
  mkdirSync(otherDl, { recursive: true })

  const pause = (ms) => new Promise((res) => setTimeout(res, ms))

  // The menu trigger has aria-haspopup, so AX exposes it as a popup button rather than
  // role "button" — match by name only (same as openManageStorage/leaveSpace). The header
  // menu is the FIRST "More"; the share card adds its own once a folder is shared.
  const openEditModal = async () => {
    await B.click({ name: 'More' })
    await pause(400)
    await B.click({ name: 'Edit Space' })
    await B.waitText('Download Folder', 20000)
  }
  const closeModal = async () => {
    await B.click({ name: 'Close' })
    await pause(400)
  }
  const saveModal = async () => {
    await B.click({ role: 'button', name: 'Save Changes' })
    await pause(600)
  }

  try {
    await r.ok('A shares a folder; B downloads it into the default folder', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addOwnedFolder(ownDir)
      await B.waitText('Archive', 60000)
      await B.openFolder('Archive')
      await B.waitText('notes.txt', 20000)
      await B.click({ role: 'button', name: 'Download' })
      const landed = path.join(B.downloadFolder, 'notes.txt')
      await waitFor(() => existsSync(landed), 60000, 'notes.txt downloaded')
      assert(readFileSync(landed, 'utf8') === 'shared notes', 'downloaded bytes match')
      await B.waitText('On your device', 20000)
      await B.click({ name: 'Back' })
      await B.waitText('Archive', 20000)
    })

    await r.ok('the edit modal shows the default folder as inherited', async () => {
      await openEditModal()
      assert(await B.hasText('Using the default download folder.'), 'inherited state is stated')
      await B.shot('s107-B-edit-modal-default', runDir)
      await closeModal()
    })

    await r.ok('picking a folder then closing discards the change', async () => {
      await openEditModal()
      await B.click({ name: 'Change' })
      await B.nativeChoosePath(spaceDl)
      await pause(600)
      assert(await B.hasText(spaceDl), 'the picked path is staged in the modal')
      await closeModal()
      await openEditModal()
      assert(await B.hasText('Using the default download folder.'), 'closing left the space on the default')
      await closeModal()
    })

    await r.ok('saving a new folder flips the downloaded row back to available', async () => {
      await openEditModal()
      await B.click({ name: 'Change' })
      await B.nativeChoosePath(spaceDl)
      await pause(600)
      await saveModal()
      await B.openFolder('Archive')
      await B.waitText('Available', 30000)
      assert(!(await B.hasText('On your device')), 'the old copy no longer counts as on-device')
      assert(existsSync(path.join(B.downloadFolder, 'notes.txt')), 'the downloaded file was NOT moved or deleted')
      await B.shot('s107-B-out-of-scope', runDir)
    })

    await r.ok('re-downloading lands in the new folder, leaving the original in place', async () => {
      await B.click({ role: 'button', name: 'Download' })
      await waitFor(() => existsSync(path.join(spaceDl, 'notes.txt')), 60000, 'downloaded into the new folder')
      await B.waitText('On your device', 20000)
      assert(existsSync(path.join(B.downloadFolder, 'notes.txt')), 'the original copy is still untouched')
      await B.click({ name: 'Back' })
      await B.waitText('Archive', 20000)
    })

    // An override is a promise that this space's files live in one folder; dropping it
    // withdraws the promise rather than making a different one, so the tracked copy still
    // counts. Only NEW downloads move. (Scoping on the effective root instead would mean a
    // change to the GLOBAL folder silently un-downloads every space that never overrode it.)
    await r.ok('resetting to the default keeps the tracked copy and moves nothing', async () => {
      await openEditModal()
      assert(!(await B.hasText('Using the default download folder.')), 'shown as overridden')
      await B.click({ name: 'Use default folder' })
      await pause(300)
      await saveModal()
      await openEditModal()
      assert(await B.hasText('Using the default download folder.'), 'back to the default')
      await closeModal()
      await B.openFolder('Archive')
      await B.waitText('On your device', 30000)
      assert(existsSync(path.join(B.downloadFolder, 'notes.txt')), 'the default-folder copy is still on disk')
      assert(existsSync(path.join(spaceDl, 'notes.txt')), 'the per-space copy is still on disk')
      await B.click({ name: 'Back' })
      await B.waitText('Archive', 20000)
    })

    // The load-bearing guarantee: the claim is kept, not pruned, when a file falls out of
    // scope — so pointing the space back at the folder restores it with no re-download.
    await r.ok('pointing the space back at the folder restores it with no re-download', async () => {
      await openEditModal()
      await B.click({ name: 'Change' })
      await B.nativeChoosePath(otherDl)
      await pause(600)
      await saveModal()
      await B.openFolder('Archive')
      await B.waitText('Available', 30000)
      assert(existsSync(path.join(spaceDl, 'notes.txt')), 'the tracked copy was not moved or deleted')
      await B.click({ name: 'Back' })
      await B.waitText('Archive', 20000)

      await openEditModal()
      await B.click({ name: 'Change' })
      await B.nativeChoosePath(spaceDl)
      await pause(600)
      await saveModal()
      await B.openFolder('Archive')
      await B.waitText('On your device', 30000)
      assert(!existsSync(path.join(spaceDl, 'notes (1).txt')), 'restored from the surviving claim, not re-fetched')
      assert(!existsSync(path.join(otherDl, 'notes.txt')), 'and nothing was fetched into the folder we passed through')
      await B.shot('s107-B-restored', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
