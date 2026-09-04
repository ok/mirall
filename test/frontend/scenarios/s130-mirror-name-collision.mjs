import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

// The UI half of FIX-MIRROR-RENAME. Bob already has a file at the name the share uses, so the
// mirror materializes the owner's copy under a sibling and leaves Bob's alone — and the folder view
// must still report that row as on-device. share-listing derived the local path from the owner key
// alone, so it stat'd a path the mirror never wrote: the header undercounted by one and the row
// wore "Available" for a file already on disk.
export default async function s130 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const ownDir = path.join(workDir('own-'), 'Vault')
  const mirrorDir = workDir('mirror-')
  mkdirSync(ownDir, { recursive: true })
  writeFileSync(path.join(ownDir, 'report.pdf'), 'ALICE OWNS THIS ONE')
  writeFileSync(path.join(ownDir, 'plain.txt'), 'no collision here')
  // The collision: Bob's own file at the same leaf name, with DIFFERENT bytes and length. The
  // length matters — share-listing's synced test is statSizeOrNull(abs) === entry.size, so an
  // equal-length decoy would make the pre-fix path accidentally correct.
  writeFileSync(path.join(mirrorDir, 'report.pdf'), "BOB'S OWN FILE, a different length entirely")

  try {
    await r.ok('B mirrors into a folder that already holds a file at the share name', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addOwnedFolder(ownDir)
      await B.waitText('Vault', 60000)
      await B.mirrorShare(mirrorDir)
      await waitFor(() => existsSync(path.join(mirrorDir, 'plain.txt')), 60000, 'the uncontested file materialized')
    })

    await r.ok("the owner's copy lands beside Bob's file, not over it", async () => {
      const sibling = () => readdirSync(mirrorDir).find((f) => f !== 'report.pdf' && f.startsWith('report') && f.endsWith('.pdf'))
      await waitFor(() => !!sibling(), 60000, 'a sibling was minted for the colliding name')
      assert(readFileSync(path.join(mirrorDir, sibling()), 'utf8') === 'ALICE OWNS THIS ONE', "the sibling holds Alice's bytes")
      assert(readFileSync(path.join(mirrorDir, 'report.pdf'), 'utf8').startsWith("BOB'S OWN FILE"), "Bob's file is untouched")
    })

    // The regression at the folder level. FolderStatsCard composes fileCount + ' · ' +
    // onDeviceCount into ONE <p> and mirrorSync counts 'synced' rows, so before the fix a
    // fully-materialized two-file mirror reported one.
    await r.ok('the folder reports BOTH files as on the device', async () => {
      await B.openFolder('Vault')
      await B.waitText('2 on your device', 60000)
      await B.shot('s130-B-collision-both-on-device', runDir)
    })

    // The same bug at the row level. Asserted through the badge's accessible name rather than the
    // visible word: hasText is a case-folded whole-window substring, so a bare "Available" also
    // matches status.unavailable ("Not available") and folder.unavailable ("Folder unavailable").
    // The named form is exact and scoped to one row, and it names the OWNER's relPath — the row
    // the bug mis-rendered.
    await r.ok('the renamed row is badged as on-device, not merely available', async () => {
      await B.waitText('report.pdf: On your device', 30000)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
