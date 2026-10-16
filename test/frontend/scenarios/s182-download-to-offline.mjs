import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

// The space's folder goes away mid-session (an ejected drive). Once the app knows — a download
// into it fails and the worker re-probes the folders — every Download-to surface says so: the
// controls-row button reads "<folder> · not connected" in the warning tone, the strip's main half
// stays focusable but inert and the selection sentence names the folder, the menus show the folder
// disabled, and a sticky toast names the space with "Choose another folder", which opens it, where
// the controls row offers the folder change. Picking another folder there clears the toast — with no
// "available again", since the old folder is still gone — and unblocks the download that was
// waiting on the missing one.
export default async function s182({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const ownDir = path.join(workDir('own-'), 'Handover')
  mkdirSync(ownDir, { recursive: true })
  for (const name of ['a.txt', 'b.txt', 'c.txt']) writeFileSync(path.join(ownDir, name), `contents of ${name}`)
  const rescue = workDir('rescue-')
  mkdirSync(rescue, { recursive: true })
  const gone = () => path.basename(B.downloadFolder)
  const offlineButton = () => `Downloads go to ${gone()} · not connected, change`

  try {
    await r.ok('B downloads one file, then its folder goes away and the next download waits on it', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addOwnedFolder(ownDir)
      await B.waitText('Handover', 60000)
      await B.openFolder('Handover')
      await B.waitText('c.txt', 30000)
      await B.downloadRow()
      await waitFor(() => existsSync(path.join(B.downloadFolder, 'Handover', 'a.txt')), 60000, 'a.txt downloaded')
      rmSync(B.downloadFolder, { recursive: true, force: true })
      // a.txt's copy went with the folder, so its row offers Download to… again: target the last row.
      await B.downloadRow({ last: true })
      await waitFor(() => B.has({ role: 'button', name: 'Retry' }), 30000, 'c.txt\'s row shows the failure')
    })

    await r.ok('the controls-row button reads not connected, and a toast names the space', async () => {
      await waitFor(() => B.has({ name: offlineButton() }), 30000, 'the button names the folder as not connected')
      await B.waitText(`Aurora downloads to ${gone()}, which is not connected`, 20000)
      await B.shot('s182-offline', runDir)
    })

    await r.ok('the row menu shows the folder disabled, with why', async () => {
      await B.openDownloadMenu({ role: 'combobox', name: 'Download to…', last: true })
      const [first] = await B.downloadMenuItems()
      assert(first && first.name === gone() && first.states.includes('disabled'), `the folder is offered disabled (saw ${JSON.stringify(first)})`)
      assert(await B.hasText('drive not connected'), 'its second line says why')
      await B.shot('s182-menu', runDir)
      await B.press('Escape')
      await waitFor(async () => (await B.downloadMenuItems()).length === 0, 10000, 'the menu closed')
    })

    await r.ok('the strip\'s main half is inert and the sentence names the folder', async () => {
      await B.click({ role: 'checkbox', contains: 'Select all' })
      await B.waitText('selected', 20000)
      await B.waitText(`${gone()}: drive not connected`, 10000)
      const main = { role: 'button', contains: ` to ${gone()}` }
      await waitFor(() => B.has(main), 10000, 'the main half names the missing folder')
      // aria-disabled keeps it in the Tab order; AX reports it disabled, so it takes no press.
      assert(await B.isDisabled(main), 'the main half reads disabled')
      await B.shot('s182-strip', runDir)
      await B.click({ role: 'button', name: 'Done' })
      await waitFor(async () => !(await B.hasText('selected')), 10000, 'the selection ended')
    })

    await r.ok('"Choose another folder" opens the space, which offers the folder change', async () => {
      await B.click({ role: 'button', name: 'Choose another folder' })
      await B.waitText('Folders Shared', 20000)
      assert(await B.has({ name: 'Open Handover' }), 'the space view lists its folders')
      await waitFor(() => B.has({ name: offlineButton() }), 20000, 'the space\'s Downloads to button reads not connected')
    })

    await r.ok('picking another folder clears the toast and unblocks the waiting download', async () => {
      await B.setDownloadsTo({ from: offlineButton(), path: rescue })
      await B.waitText(`Downloads from Aurora now go to ${path.basename(rescue)}`, 20000)
      await waitFor(async () => !(await B.hasText('which is not connected')), 20000, 'the fault toast cleared')
      assert(!(await B.hasText('Download folder is available again')), 'nothing came back, so nothing says it did')
      // The space lists nothing of another member's to download, so its button steps back once the
      // folder can be reached; the folder screen's button names the new folder.
      await waitFor(async () => !(await B.has({ name: offlineButton() })), 20000, 'the space no longer warns')
      await B.openFolder('Handover')
      await waitFor(() => B.has({ name: `Downloads go to ${path.basename(rescue)}, change` }), 20000, 'the button is back to normal')
      await waitFor(() => existsSync(path.join(rescue, 'Handover', 'c.txt')), 90000, 'c.txt landed in the new folder without a retry')
      await B.shot('s182-recovered', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
