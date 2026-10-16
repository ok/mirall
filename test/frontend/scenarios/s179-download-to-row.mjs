import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'
import { findNode } from '../tree.mjs'

// A row's Download opens the Download-to menu: a heading, the space's folder first and checked with
// its path beside it, the recent folders, and Choose Folder…. Escape closes it and downloads
// nothing. A pick downloads the file into <folder>/<share>/<path>, makes that folder the space's,
// says so in one toast and moves the controls-row button with it. The menu holds the last three
// folders: a fourth pushes the oldest out.
const FILES = ['a.txt', 'b.txt', 'c.txt', 'd.txt']

export default async function s179({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const ownDir = path.join(workDir('own-'), 'Handover')
  mkdirSync(ownDir, { recursive: true })
  for (const name of FILES) writeFileSync(path.join(ownDir, name), `contents of ${name}`)
  const picks = ['pick-x-', 'pick-y-', 'pick-z-'].map((p) => workDir(p))
  for (const dir of picks) mkdirSync(dir, { recursive: true })
  const [X, Y, Z] = picks
  const name = (dir) => path.basename(dir)
  const shown = (p) => (p.startsWith(homedir() + path.sep) ? '~' + p.slice(homedir().length) : p)
  const landed = (dir, file) => path.join(dir, 'Handover', file)
  const rowMenu = (file) => ({ role: 'combobox', name: 'Download to…', ...(file === FILES.at(-1) ? { last: true } : {}) })
  const changed = (dir) => `Downloads from Aurora now go to ${name(dir)}`
  const button = (dir) => ({ name: `Downloads go to ${name(dir)}, change` })

  try {
    await r.ok('B opens a browse folder; every Available row offers Download to…', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addOwnedFolder(ownDir)
      await B.waitText('Handover', 60000)
      await B.openFolder('Handover')
      await B.waitText('d.txt', 30000)
      await waitFor(() => B.has(rowMenu('a.txt')), 20000, 'the rows offer Download to…')
      await waitFor(() => B.has(button(B.downloadFolder)), 20000, 'the controls row names the space\'s folder')
    })

    await r.ok('the menu: heading, the space\'s folder checked with its path, Choose Folder…', async () => {
      await B.openDownloadMenu(rowMenu('a.txt'))
      const items = await B.downloadMenuItems()
      assert(items.length === 2, `one folder and Choose Folder… (saw ${JSON.stringify(items.map((i) => i.name))})`)
      assert(items[0].name === name(B.downloadFolder) && items[0].value === '1', `the space's folder is first and checked (saw ${JSON.stringify(items[0])})`)
      assert(items[1].name === 'Choose Folder…' && items[1].value !== '1', 'Choose Folder… is last and not checked')
      assert(findNode(await B.snap(), { role: 'statictext', name: 'DOWNLOAD TO' }), 'the heading is read')
      assert(await B.hasText(shown(B.downloadFolder)), 'the folder\'s path is its second line')
      await B.shot('s179-menu', runDir)
    })

    await r.ok('Escape closes the menu and downloads nothing', async () => {
      await B.press('Escape')
      await waitFor(async () => (await B.downloadMenuItems()).length === 0, 10000, 'the menu closed')
      await new Promise((res) => setTimeout(res, 1500))
      assert(!existsSync(landed(B.downloadFolder, 'a.txt')), 'nothing landed')
      assert(await B.has({ name: 'a.txt: Available' }), 'the row is still Available')
    })

    await r.ok('Choose Folder… downloads there, makes it the space\'s folder and says so once', async () => {
      await B.downloadRow(rowMenu('a.txt'), { path: X })
      await waitFor(() => existsSync(landed(X, 'a.txt')), 60000, 'a.txt landed in <X>/Handover')
      await B.waitText(changed(X), 20000)
      await waitFor(() => B.has(button(X)), 20000, 'the controls-row button names the new folder')
      assert(!existsSync(landed(B.downloadFolder, 'a.txt')), 'nothing landed in the old folder')
    })

    await r.ok('a recent folder is one pick away, and picking it moves the space back', async () => {
      await B.openDownloadMenu(rowMenu('b.txt'))
      const items = await B.downloadMenuItems()
      assert(JSON.stringify(items.map((i) => i.name)) === JSON.stringify([name(X), name(B.downloadFolder), 'Choose Folder…']), `the new folder first, then the recent one (saw ${JSON.stringify(items.map((i) => i.name))})`)
      assert(items[0].value === '1' && items[1].value !== '1', 'the new folder is the checked one')
      await B.pickDownloadFolder(rowMenu('b.txt'), { folder: name(B.downloadFolder) })
      await waitFor(() => existsSync(landed(B.downloadFolder, 'b.txt')), 60000, 'b.txt landed in the recent folder')
      await B.waitText(changed(B.downloadFolder), 20000)
      await waitFor(() => B.has(button(B.downloadFolder)), 20000, 'the button follows')
      await B.shot('s179-recent', runDir)
    })

    await r.ok('a download into the space\'s own folder says nothing about the folder', async () => {
      await waitFor(async () => !(await B.hasText('now go to')), 30000, 'the change toast has gone')
      await B.downloadRow(rowMenu('c.txt'))
      await waitFor(() => existsSync(landed(B.downloadFolder, 'c.txt')), 60000, 'c.txt landed in the space\'s folder')
      await new Promise((res) => setTimeout(res, 1500))
      assert(!(await B.hasText('now go to')), 'no toast')
    })

    await r.ok('the menu keeps the last three folders: a fourth pushes the oldest out', async () => {
      await B.setDownloadsTo({ path: Y })
      await B.waitText(changed(Y), 20000)
      await B.downloadRow(rowMenu('d.txt'), { path: Z })
      await waitFor(() => existsSync(landed(Z, 'd.txt')), 60000, 'd.txt landed in <Z>/Handover')
      await B.waitText(changed(Z), 20000)
      await B.openDownloadMenu({ role: 'combobox', contains: 'Downloads go to' })
      const items = (await B.downloadMenuItems()).map((i) => i.name)
      assert(JSON.stringify(items) === JSON.stringify([name(Z), name(Y), name(B.downloadFolder), 'Choose Folder…']), `newest first, the oldest gone (saw ${JSON.stringify(items)})`)
      await B.shot('s179-three-recent', runDir)
      await B.press('Escape')
      assert(readdirSync(Y).length === 0, 'the controls row only changed the folder; nothing downloaded into it')
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
