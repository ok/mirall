import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

// The space's own download folder, set in Edit Space under "Downloads go to". Every space has one,
// so there is no default to fall back to and no "Use default folder". Changes apply on Save, so
// closing the modal discards them; a saved change says so in one toast and moves the controls-row
// button with it. Switching folders never moves or deletes a file: a copy already downloaded stays
// on the device, its row naming the folder it is in, and only new downloads land in the new folder.
export default async function s107({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const ownDir = path.join(workDir('own-'), 'Archive')
  mkdirSync(ownDir, { recursive: true })
  writeFileSync(path.join(ownDir, 'notes.txt'), 'shared notes')
  writeFileSync(path.join(ownDir, 'later.txt'), 'downloaded after the change')

  const spaceDl = workDir('space-dl-')
  mkdirSync(spaceDl, { recursive: true })
  const shown = (p) => (p.startsWith(homedir() + path.sep) ? '~' + p.slice(homedir().length) : p)

  const pause = (ms) => new Promise((res) => setTimeout(res, ms))

  // The menu trigger has aria-haspopup, so AX exposes it as a popup button rather than
  // role "button" — match by name only. The header menu is the FIRST "More"; the share card adds
  // its own once a folder is shared.
  const openEditModal = async () => {
    await B.click({ name: 'More' })
    await pause(400)
    await B.click({ name: 'Edit Space' })
    await B.waitText('Downloads go to', 20000)
  }
  const closeModal = async () => {
    await B.click({ name: 'Close' })
    await pause(400)
  }

  try {
    await r.ok('A shares a folder; B downloads a file into the space\'s folder', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addOwnedFolder(ownDir)
      await B.waitText('Archive', 60000)
      await B.openFolder('Archive')
      await B.waitText('notes.txt', 20000)
      // Rows sort by name: later.txt, then notes.txt.
      await B.downloadRow({ last: true })
      const landed = path.join(B.downloadFolder, 'Archive', 'notes.txt')
      await waitFor(() => existsSync(landed), 60000, 'notes.txt downloaded')
      assert(readFileSync(landed, 'utf8') === 'shared notes', 'downloaded bytes match')
      await B.waitText('On your device', 20000)
      assert(!(await B.hasText('now go to')), 'a download into the current folder says nothing about the folder')
      await B.click({ name: 'Back' })
      await B.waitText('Archive', 20000)
    })

    await r.ok('Edit Space shows the space\'s folder under "Downloads go to", with no default to fall back to', async () => {
      await openEditModal()
      assert(await B.hasText(B.downloadFolder), 'the space\'s folder is shown')
      assert(!(await B.hasText('Use default folder')), 'no link back to a default')
      assert(!(await B.hasText('Using the default download folder')), 'no inherited state')
      await B.shot('s107-B-edit-modal', runDir)
      await closeModal()
    })

    await r.ok('picking a folder then closing discards the change', async () => {
      await openEditModal()
      await B.nativeChoosePath(spaceDl, { trigger: () => B.click({ role: 'button', name: 'Change' }) })
      await waitFor(() => B.hasText(spaceDl), 10000, 'the picked path is staged in the modal')
      await closeModal()
      assert(!(await B.hasText('now go to')), 'nothing was saved, so nothing is announced')
      await openEditModal()
      assert(await B.hasText(B.downloadFolder), 'closing kept the space\'s folder')
      assert(!(await B.hasText(spaceDl)), 'the staged pick is gone')
      await closeModal()
    })

    await r.ok('saving a new folder says so once, and the downloaded copy stays on the device', async () => {
      await openEditModal()
      await B.nativeChoosePath(spaceDl, { trigger: () => B.click({ role: 'button', name: 'Change' }) })
      await waitFor(() => B.hasText(spaceDl), 10000, 'the picked path is staged in the modal')
      await B.click({ role: 'button', name: 'Save Changes' })
      await B.waitText(`Downloads from Aurora now go to ${path.basename(spaceDl)}`, 20000)
      await B.shot('s107-B-folder-changed', runDir)
      await B.openFolder('Archive')
      await waitFor(() => B.has({ name: `Downloads go to ${path.basename(spaceDl)}, change` }), 20000, 'the controls-row button names the new folder')
      await B.waitText('On your device', 30000)
      await B.waitText(`In ${shown(path.join(B.downloadFolder, 'Archive'))}`, 20000)
      assert(existsSync(path.join(B.downloadFolder, 'Archive', 'notes.txt')), 'the downloaded file was NOT moved or deleted')
      await B.shot('s107-B-copy-stays', runDir)
    })

    await r.ok('a new download lands in the new folder, leaving the earlier copy in place', async () => {
      await B.downloadRow()
      await waitFor(() => existsSync(path.join(spaceDl, 'Archive', 'later.txt')), 60000, 'later.txt downloaded into the new folder')
      assert(!existsSync(path.join(B.downloadFolder, 'Archive', 'later.txt')), 'nothing landed in the old folder')
      assert(existsSync(path.join(B.downloadFolder, 'Archive', 'notes.txt')), 'the earlier copy is still there')
      await waitFor(async () => !(await B.hasText('Available')), 30000, 'both rows are on the device')
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
