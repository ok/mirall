import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { allText } from '../tree.mjs'
import { workDir } from '../paths.mjs'

// A file that is only QUEUED has no catalog entry yet, so it has no row — and the folder view used
// to say nothing at all about it. Drop a batch of large files in and only the two or three the lane
// can hash at once appeared; the rest were invisible until their turn came, which for multi-GB files
// is minutes of a folder that looks like it is doing nothing. The owner now gets a scan notice
// counting the whole outstanding queue, announced through a live region.
//
// Owner-only: a member has no view of our scheduler (that is the follow-up that broadcasts it).
// Ten 256 MB files so the queue is several deep behind the lane's 2 bulk slots + 1 express, and so
// the window stays open long enough for the AX poll to catch it.
export default async function s120 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1 })

  const ownDir = path.join(workDir('own-'), 'Archive')
  mkdirSync(ownDir, { recursive: true })
  writeFileSync(path.join(ownDir, 'readme.txt'), 'so the folder exists at share time')

  try {
    await r.ok('A shares "Archive" and opens it', async () => {
      await A.launch()
      await A.createSpaceOnly('Aurora')
      await A.addOwnedFolder(ownDir)
      await A.waitText('Archive', 60000)
      await A.openFolder('Archive')
      await A.waitText('readme.txt', 60000)
    })

    await r.ok('a batch dropped in is announced as a whole, including the files still waiting', async () => {
      for (let i = 0; i < 10; i++) {
        writeFileSync(path.join(ownDir, `vol-0${i}.bin`), Buffer.alloc(256 * 1024 * 1024, 11 + i))
      }
      let text = ''
      await waitFor(async () => {
        // A transient AX condition is "not yet", not a failure (parity with instance.waitText).
        try { text = allText(await A.snap()) } catch { return false }
        return /adding \d+ files to this folder/i.test(text)
      }, 90000, 'the folder announces the scan')
      await A.shot('s120-A-scan-notice', runDir)

      const count = Number(/adding (\d+) files to this folder/i.exec(text)?.[1] ?? 0)
      // The lane runs at most 2 bulk + 1 express at a time, so any count above that is work the
      // rows cannot be showing — exactly the queued files this notice exists to surface.
      assert(count > 3, `the notice counts queued work, not just what is running (saw ${count})`)
      assert(!/downloading/i.test(text), 'indexing our own folder is never called a download')
    })

    await r.ok('the notice clears once the scan drains', async () => {
      await waitFor(async () => {
        const text = allText(await A.snap())
        return /shared by you/i.test(text) && !/adding \d+ files to this folder/i.test(text)
      }, 180000, 'the scan notice goes away when there is nothing left to add')
      await A.shot('s120-A-settled', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
