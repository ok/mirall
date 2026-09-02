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
// What this scenario pins is the user-visible half of the fix, which no lower layer can see:
// the specific reason reaches the file row, a sticky toast names the folder and offers the fix,
// Storage Settings marks it, and all of it clears once a working folder is chosen. The negative
// assertion (`Transfer failed` absent) is the actual bug, so it is asserted explicitly rather
// than implied by the positive one.
export default async function s109 ({ runDir, bootstrap }) {
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

  const pause = (ms) => new Promise((res) => setTimeout(res, ms))

  try {
    await r.ok('B downloads normally while its download folder exists', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addOwnedFolder(ownDir)
      await B.waitText('Archive', 60000)
      await B.openFolder('Archive')
      await B.waitText('notes.txt', 20000)
      await B.click({ role: 'button', name: 'Download' })
      await waitFor(() => existsSync(path.join(B.downloadFolder, 'notes.txt')), 60000, 'first file downloaded')
      await B.waitText('On your device', 20000)
    })

    await r.ok('with the folder deleted, the failure names the folder — not "Transfer failed"', async () => {
      // The folder goes away behind the app's back: an ejected disk, a dropped network share, or
      // simply the user deleting it. Nothing tells the app.
      rmSync(B.downloadFolder, { recursive: true, force: true })
      assert(!existsSync(B.downloadFolder), 'precondition: the download folder is gone')

      // second.txt has never been downloaded, so its row still offers Download.
      await B.click({ role: 'button', name: 'Download', last: true })
      await B.waitText('Download folder unavailable', 30000)

      // That text alone does not say WHICH surface rendered it: the row's error string is a
      // prefix of the toast's, and waitText scans the whole tree. Only an errored row offers
      // Retry, so this is what actually pins "the specific reason reached the file row" — without
      // it the row half could regress silently while the toast kept the scenario green.
      await waitFor(() => B.has({ role: 'button', name: 'Retry' }), 20000, 'the file row shows the failure')

      // The bug, stated directly.
      assert(!(await B.hasText('Transfer failed')), 'the generic catch-all is NOT what the user sees')
      assert(!(await B.hasText('Permission denied')), 'nor the misleading permission message')

      // The preflight refuses before any write, so the deleted folder is not silently recreated.
      assert(!existsSync(B.downloadFolder), 'the deleted folder was not resurrected by the download')
      await B.shot('s109-B-download-folder-gone', runDir)
    })

    await r.ok('a sticky toast names the folder and offers a way out', async () => {
      // Raised off the worker probe, which the renderer re-queries the moment a transfer reports
      // the folder gone — so it must be up without waiting out the 60s probe interval.
      await B.waitText('Change folder', 20000)
      assert(await B.hasText(B.downloadFolder), 'the toast names the folder that is missing')
      await B.shot('s109-B-toast', runDir)
    })

    await r.ok('Storage Settings marks the folder as unavailable', async () => {
      await B.click({ name: 'Back' })
      await B.waitText('Archive', 20000)
      await B.openManageStorage()
      await B.waitText('This folder is currently unavailable', 20000)
      await B.shot('s109-B-storage-settings-warning', runDir)
    })

    await r.ok('choosing a working folder clears the toast and the warning', async () => {
      // The Browse click is handed to nativeChoosePath as the trigger rather than fired here,
      // so a swallowed one is re-fired instead of timing out on a panel that never opens.
      await B.nativeChoosePath(rescueDl, { trigger: () => B.click({ role: 'button', name: 'Change' }) })
      await pause(1200)
      assert(await B.hasText(rescueDl), 'the new folder is shown')
      await waitFor(async () => !(await B.hasText('This folder is currently unavailable')), 20000,
        'the settings warning cleared')
      // The sticky fault toast is replaced by the recovery notice (same toast id), so the fault
      // text and its action both go away.
      await waitFor(async () => !(await B.hasText('Change folder')), 20000, 'the fault toast cleared')
      await B.waitText('Download folder is available again', 20000)
      await B.shot('s109-B-recovered', runDir)
    })

    await r.ok('the download that failed now succeeds into the new folder', async () => {
      await B.click({ name: 'Back' })
      await B.waitText('Archive', 30000)
      await B.openFolder('Archive')
      await B.waitText('second.txt', 20000)
      // The failed row offers Retry, not Download — which is also what makes it targetable here.
      // notes.txt has meanwhile reverted to Download (its copy lived in the folder that is gone),
      // so a name:'Download' match would be ambiguous between the two rows.
      await B.click({ role: 'button', name: 'Retry' })
      await waitFor(() => existsSync(path.join(rescueDl, 'second.txt')), 60000, 'downloaded into the new folder')
      assert(!(await B.hasText('Download folder unavailable')), 'no stale failure text left behind')
    })
  } catch {}

  return { pass: r.summary(), instances: [A, B] }
}
