import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert } from '../assert.mjs'
import { workDir } from '../paths.mjs'

const sleep = (ms) => new Promise((res) => setTimeout(res, ms))

// A2 — the LOOSE FileCard twin of s49: cancel a loose download mid-flight. The row
// reverts to "Available" + Download and the partial never lands at the destination.
// Same IPC (files:cancel-download), different surface (space-root card vs FolderView),
// separate a11y guarantee. Loose downloads are inPlace, so the row's secondary Cancel
// is offered while running (unlike a folder-mirror row). 256 MB gives a comfortable
// mid-flight window so the Cancel control is caught.
export default async function s83 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const dir = workDir('loose-cancel-')
  const big = path.join(dir, 'lump.bin')
  mkdirSync(dir, { recursive: true })
  writeFileSync(big, Buffer.alloc(256 * 1024 * 1024, 13))
  const landed = path.join(B.downloadFolder, 'lump.bin')

  let sawCancel = false
  try {
    await r.ok('A shares a big loose file; B sees it Available', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addFile(big)
      await A.waitText('lump', 60000)
      await B.waitText('lump', 90000)
      await B.waitText('Available', 90000)
    })

    await r.ok('B downloads then cancels; row reverts to Available, no partial lands', async () => {
      await B.click({ role: 'button', name: 'Download', last: true })

      const dl = Date.now() + 20000
      while (Date.now() < dl) {
        if (await B.has({ role: 'button', name: 'Cancel' })) { sawCancel = true; break }
        if (await B.hasText('On your device')) break
        await sleep(200)
      }
      assert(sawCancel, 'Cancel is reachable by role+name during a loose download')
      await B.shot('s83-B-cancel-visible', runDir)

      await B.click({ role: 'button', name: 'Cancel' })

      // Cancel discards the partial; the row re-derives to remote ("Available") with a
      // Download button (the file is still shared — only the download was cancelled).
      const rev = Date.now() + 20000
      let back = false
      while (Date.now() < rev) {
        if (await B.has({ role: 'button', name: 'Download' }) && await B.hasText('Available')) { back = true; break }
        await sleep(200)
      }
      assert(back, 'row shows Available + Download after cancel')
      assert(!existsSync(landed), 'no file landed at the destination after cancel')
      await B.shot('s83-B-cancelled', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
