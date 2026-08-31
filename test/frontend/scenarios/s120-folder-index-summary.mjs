import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { allText } from '../tree.mjs'
import { workDir } from '../paths.mjs'

// A file that is only QUEUED has no catalog entry yet, so it has no row — and the folder view used
// to say nothing at all about it. Drop a batch of large files in and only the two or three the lane
// can hash at once appeared; the rest were invisible until their turn came, which for multi-GB files
// is minutes of a folder that looks like it is doing nothing.
//
// Both sides now get a scan notice, announced through a live region: the owner counts its own queue,
// and a member is told the same by the owner over the handshake channel — a queued file replicates
// nothing, so without that broadcast a member could not learn of it at all.
//
// Ten 256 MB files so the queue is several deep behind the lane's 2 bulk slots + 1 express, and so
// the window stays open long enough for the AX polls to catch it on both screens.
export default async function s120 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const ownDir = path.join(workDir('own-'), 'Archive')
  mkdirSync(ownDir, { recursive: true })
  writeFileSync(path.join(ownDir, 'readme.txt'), 'so the folder exists at share time')

  // Caught on ONE snapshot, like s119: the count and the "never a download" claim must read the
  // same instant, or a fast hash lets the second pass on an empty window.
  const catchWindow = async (P, pred, label) => {
    let text = ''
    await waitFor(async () => {
      // A transient AX condition is "not yet", not a failure (parity with instance.waitText).
      try { text = allText(await P.snap()) } catch { return false }
      return pred(text)
    }, 90000, label)
    return text
  }

  try {
    await r.ok('A shares "Archive"; both open it', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addOwnedFolder(ownDir)
      await A.waitText('Archive', 60000)
      await A.openFolder('Archive')
      await B.waitText('Archive', 60000)
      await B.openFolder('Archive')
      await B.waitText('readme.txt', 60000)
    })

    await r.ok('a batch dropped in is announced on both screens, including the files still waiting', async () => {
      for (let i = 0; i < 10; i++) {
        writeFileSync(path.join(ownDir, `vol-0${i}.bin`), Buffer.alloc(256 * 1024 * 1024, 11 + i))
      }
      const [aText, bText] = await Promise.all([
        catchWindow(A, (t) => /adding \d+ files to this folder/i.test(t), 'the owner announces its own scan'),
        catchWindow(B, (t) => /alice is adding \d+ files to this folder/i.test(t), 'the member is told whose scan it is'),
      ])
      await Promise.all([A.shot('s120-A-scan-notice', runDir), B.shot('s120-B-scan-notice', runDir)])

      // The lane runs at most 2 bulk + 1 express at a time, so any count above that is work the
      // rows cannot be showing — exactly the queued files this notice exists to surface.
      const aCount = Number(/adding (\d+) files to this folder/i.exec(aText)?.[1] ?? 0)
      assert(aCount > 3, `the owner counts queued work, not just what is running (saw ${aCount})`)
      const bCount = Number(/alice is adding (\d+) files to this folder/i.exec(bText)?.[1] ?? 0)
      assert(bCount > 3, `the member is told about files that have no catalog entry yet (saw ${bCount})`)

      assert(!/downloading/i.test(aText), 'indexing our own folder is never called a download')
      assert(!/downloading/i.test(bText), 'and a member watching it is never told it is downloading')
    })

    await r.ok('the notice clears on both once the scan drains', async () => {
      // `files?` — the singular renders at exactly one file left, and a plural-only regex would
      // call the notice gone while it is still on screen.
      await waitFor(async () => {
        const text = allText(await A.snap())
        return /shared by you/i.test(text) && !/adding \d+ files? to this folder/i.test(text)
      }, 180000, "the owner's notice goes away when there is nothing left to add")
      await waitFor(async () => {
        const text = allText(await B.snap())
        return !/alice is adding \d+ files? to this folder/i.test(text)
      }, 180000, "the member's notice goes away too — a stuck one would outlive the scan")
      await B.shot('s120-B-settled', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
