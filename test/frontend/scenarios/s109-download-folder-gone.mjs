import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

// REGRESSION (FIX-DLDIR-2/3): a download folder that disappeared produced no message the user
// could act on. The failing download said "Transfer failed" — the renderer's catch-all — and
// nothing anywhere named the folder as the cause.
//
// What this scenario pins is the user-visible half of the fix, which no lower layer can see: the
// specific reason reaches the file row; a sticky toast names the space and its folder and offers
// "Choose another folder", which opens that space, where the "Downloads to" button reads not
// connected even though the space lists no other member's file; Storage Settings marks the gone
// folder (it is also the folder new spaces start in); and choosing another folder clears the toast
// — with no "available again", since the old folder is still gone — and lets the failed download
// land in the new folder. The negative assertion (`Transfer failed` absent) is the actual bug, so
// it is asserted explicitly rather than implied by the positive one.
export default async function s109({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const ownDir = path.join(workDir('own-'), 'Archive')
  mkdirSync(ownDir, { recursive: true })
  writeFileSync(path.join(ownDir, 'notes.txt'), 'shared notes')
  writeFileSync(path.join(ownDir, 'second.txt'), 'more notes')

  const rescueDl = workDir('rescue-dl-')
  mkdirSync(rescueDl, { recursive: true })
  const gone = () => path.basename(B.downloadFolder)
  const offlineButton = () => `Downloads go to ${gone()} · not connected, change`

  try {
    await r.ok('B downloads normally while its download folder exists', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addOwnedFolder(ownDir)
      await B.waitText('Archive', 60000)
      await B.openFolder('Archive')
      await B.waitText('notes.txt', 20000)
      // Rows sort by name: notes.txt, then second.txt.
      await B.downloadRow()
      await waitFor(() => existsSync(path.join(B.downloadFolder, 'Archive', 'notes.txt')), 60000, 'first file downloaded')
      await B.waitText('On your device', 20000)
    })

    await r.ok('with the folder deleted, the failure names the folder — not "Transfer failed"', async () => {
      // The folder goes away behind the app's back: an ejected disk, a dropped network share, or
      // simply the user deleting it. Nothing tells the app.
      rmSync(B.downloadFolder, { recursive: true, force: true })
      assert(!existsSync(B.downloadFolder), 'precondition: the download folder is gone')

      // second.txt has never been downloaded; the app has not probed the folder since it went, so
      // the menu still offers it as the current folder.
      await B.downloadRow({ last: true })
      await B.waitText('Download folder unavailable', 30000)

      // That text alone does not say WHICH surface rendered it. Only an errored row offers Retry,
      // so this is what actually pins "the specific reason reached the file row".
      await waitFor(() => B.has({ role: 'button', name: 'Retry' }), 20000, 'the file row shows the failure')

      // The bug, stated directly.
      assert(!(await B.hasText('Transfer failed')), 'the generic catch-all is NOT what the user sees')
      assert(!(await B.hasText('Permission denied')), 'nor the misleading permission message')

      // The preflight refuses before any write, so the deleted folder is not silently recreated.
      assert(!existsSync(B.downloadFolder), 'the deleted folder was not resurrected by the download')
      await B.shot('s109-B-download-folder-gone', runDir)
    })

    await r.ok('a sticky toast names the space and its folder, and the folder reads not connected', async () => {
      // Raised off the worker probe, which the renderer re-queries the moment a transfer reports
      // the folder gone — so it must be up without waiting out the 60s probe interval.
      await B.waitText(`Aurora downloads to ${gone()}, which is not connected`, 20000)
      assert(await B.hasText('Choose another folder'), 'the toast offers a way out')
      await waitFor(() => B.has({ name: offlineButton() }), 20000, 'the Downloads to button reads not connected')
      await B.shot('s109-B-toast', runDir)
    })

    await r.ok('"Choose another folder" opens the space, which offers the folder change', async () => {
      await B.click({ role: 'button', name: 'Choose another folder' })
      await B.waitText('Folders Shared', 20000)
      assert(await B.has({ name: 'Open Archive' }), 'the space view lists its folders')
      // The space lists no loose file of another member: the button is there for the folder alone.
      await waitFor(() => B.has({ name: offlineButton() }), 20000, 'the space\'s Downloads to button reads not connected')
    })

    await r.ok('Storage Settings marks the folder for new spaces as unavailable', async () => {
      await B.openManageStorage()
      await B.waitText('This folder is currently unavailable', 20000)
      await B.shot('s109-B-storage-settings-warning', runDir)
      await B.click({ name: 'Back' })
      await B.waitText('Folders Shared', 20000)
    })

    await r.ok('choosing a working folder clears the toast, and the failed download lands there', async () => {
      await B.setDownloadsTo({ path: rescueDl, from: offlineButton() })
      await B.waitText(`Downloads from Aurora now go to ${path.basename(rescueDl)}`, 20000)
      await waitFor(async () => !(await B.hasText('which is not connected')), 20000, 'the fault toast cleared')
      // The old folder is still gone: nothing came back, so nothing may say it did.
      assert(!(await B.hasText('Download folder is available again')), 'no false recovery notice')
      // The space lists nothing of another member's to download, so its button steps back once the
      // folder can be reached; the folder screen's button names the new folder.
      await waitFor(async () => !(await B.has({ name: offlineButton() })), 20000, 'the space no longer warns')
      await B.openFolder('Archive')
      await waitFor(() => B.has({ name: `Downloads go to ${path.basename(rescueDl)}, change` }), 20000, 'the button names the new folder')
      await B.waitText('second.txt', 20000)
      // A folder that takes writes again re-drives the failed row on the worker's next tick, so the
      // download may already be under way; Retry is offered only until then.
      try {
        await B.click({ role: 'button', name: 'Retry' })
      } catch (e) {
        if (e.code !== 'ELEMENT_NOT_FOUND') throw e
      }
      await waitFor(() => existsSync(path.join(rescueDl, 'Archive', 'second.txt')), 60000, 'downloaded into the new folder')
      assert(!(await B.hasText('Download folder unavailable')), 'no stale failure text left behind')
      await B.shot('s109-B-recovered', runDir)
    })
  } catch {}

  return { pass: r.summary(), instances: [A, B] }
}
