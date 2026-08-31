import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { allText } from '../tree.mjs'
import { workDir } from '../paths.mjs'

// Files dropped into an owned folder are INDEXED, not transferred. Both sides used to be told
// otherwise: the owner's own rows wore the consumer's "Preparing…" pill, and the folder roll-up
// counted every indexing row as "N downloading" — on the owner's screen and on the screen of a
// member who was only watching the folder, with nobody pulling a byte. The owner now reads
// "Adding" / "N adding", the member "Preparing…" / "N preparing", and the bar is named for the
// indexing it measures instead of a download.
//
// Files are dropped in AFTER the mount so they publish interactively (visible while hashing);
// several large ones keep the window open past the AX polls that assert on it.
export default async function s119 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const ownDir = path.join(workDir('own-'), 'Media')
  const movies = path.join(ownDir, 'movies')
  mkdirSync(movies, { recursive: true })
  writeFileSync(path.join(movies, 'notes.txt'), 'so the subfolder exists at share time')

  // Caught on ONE snapshot: the "is it labelled right" and "does it claim a download" assertions
  // must read the same instant, or a fast hash lets the second one pass on an empty window.
  // The roll-up pill appears at advertise-time — BEFORE the first hashing frame — so a snapshot
  // taken on the pill alone has no bar in it yet. Wait for both, then assert on that one snapshot.
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
    await r.ok('launch + connect + A shares "Media", both open it', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addOwnedFolder(ownDir)
      await A.waitText('Media', 60000)
      await A.openFolder('Media')
      await B.waitText('Media', 60000)
      await B.openFolder('Media')
      await B.waitText('notes.txt', 60000)
    })

    await r.ok('A drops big files in; the owner reads "Adding" and the member "Preparing…" — neither says downloading', async () => {
      for (let i = 0; i < 6; i++) {
        writeFileSync(path.join(movies, `feature-0${i}.bin`), Buffer.alloc(192 * 1024 * 1024, 7 + i))
      }
      const [aText, bText] = await Promise.all([
        catchWindow(A, (t) => /\d+ adding/i.test(t) && t.includes('Indexing progress'),
          'owner folder roll-up counts the indexing files as adding, over an indexing bar'),
        catchWindow(B, (t) => /\d+ preparing/i.test(t) && t.includes('Indexing progress'),
          'member folder roll-up counts them as preparing, over an indexing bar'),
      ])
      await Promise.all([A.shot('s119-A-adding', runDir), B.shot('s119-B-preparing', runDir)])

      assert(!/downloading/i.test(aText), 'the owner is never told its own files are downloading')
      assert(/adding/i.test(aText), 'the owner rows carry the Adding pill')
      assert(aText.includes('Indexing progress'), "the owner's bar is named for the indexing it measures")

      assert(!/downloading/i.test(bText), 'a member watching the folder is never told it is downloading')
      assert(/preparing/i.test(bText), 'the member rows carry the Preparing pill')
      assert(bText.includes('Indexing progress'), "the member's bar is named for the owner's indexing")
      assert(!bText.includes('Download progress'), 'and never for a download the member did not start')
    })

    await r.ok('once indexed, both sides settle out of the indexing labels', async () => {
      await waitFor(async () => {
        const text = allText(await A.snap())
        return /shared by you/i.test(text) && !/\d+ adding/i.test(text)
      }, 120000, 'owner rows settle to Shared by you')
      await waitFor(async () => {
        const text = allText(await B.snap())
        return /available/i.test(text) && !/\d+ preparing/i.test(text)
      }, 120000, 'member rows settle to Available')
      await B.shot('s119-B-available', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
