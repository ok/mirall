import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, waitFor, dirSize, assert } from '../assert.mjs'
import { findNode } from '../tree.mjs'
import { workDir } from '../paths.mjs'

const read = (p) => { try { return readFileSync(p, 'utf8') } catch { return null } }

// REGRESSION (FIX-267-DISPLAY): a same-size local edit of a mirrored file kept listing as "On your
// device" with the verified check, while the next mirror pass was about to move it aside. The row
// must say "Edited locally", drop the check, offer Reveal, and print the consequence as text under
// the file name; the next pass then keeps the edit as a conflicted copy and restores the owner's
// version.
//
// The edit is made while the owner is away: the mirror's watcher asks for a walk at once, but a
// pass gated on an offline owner walks nothing, so the row keeps its edited state until the owner
// returns — and their return is the next sync the third step waits for.
export default async function s148({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const ownDir = path.join(workDir('own-'), 'Ledger')
  const mirrorDir = workDir('mirror-')
  const mirrored = path.join(mirrorDir, 'report.txt')
  const conflicted = path.join(mirrorDir, 'report (conflicted copy).txt')
  const original = 'the owner wrote these bytes'
  const edited = 'bob changed these bytes too'
  mkdirSync(ownDir, { recursive: true })
  writeFileSync(path.join(ownDir, 'report.txt'), original)

  try {
    await r.ok('A shares "Ledger"; B mirrors it and the file lands verified', async () => {
      assert(edited.length === original.length, 'the edit keeps the size, so only the fingerprint can see it')
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addOwnedFolder(ownDir)
      await B.waitText('Ledger', 60000)
      await B.mirrorShare(mirrorDir)
      await waitFor(() => dirSize(mirrorDir) > 0 && read(mirrored) === original, 90000, 'mirrored bytes on disk')
      await B.openFolder('Ledger')
      await waitFor(() => B.has({ contains: 'content hash matches' }), 30000, 'the mirrored row starts verified')
      await B.back()
    })
    await r.ok('a same-size local edit reads "Edited locally", unverified, with Reveal', async () => {
      await A.quit()
      writeFileSync(mirrored, edited)
      await B.openFolder('Ledger')
      await B.waitText('Edited locally', 20000)
      assert(!(await B.has({ contains: 'content hash matches' })), 'the verified check is gone')
      assert(await B.hasText('conflicted copy'), 'the row says what the next sync does, as text a screen reader reaches in order')
      assert(findNode(await B.snap(), { role: 'button', name: 'Reveal in Folder' }), 'the edited row offers Reveal')
      await B.shot('s148-B-edited-locally', runDir)
    })
    await r.ok('the next sync keeps the edit as a conflicted copy and restores the owner version', async () => {
      await A.launch({ onboard: false })
      await waitFor(() => read(conflicted) === edited, 90000, 'the edit kept as a conflicted copy')
      await waitFor(() => read(mirrored) === original, 30000, 'the owner version restored at the natural name')
      // Several re-lists follow a landing; the row has settled once the edited state is gone and the
      // restored file reads verified.
      await waitFor(async () => !(await B.hasText('Edited locally')), 30000, 'the edited state cleared')
      await B.waitText('On your device', 30000)
      await waitFor(() => B.has({ contains: 'content hash matches' }), 30000, 'the restored row is verified again')
      assert(existsSync(conflicted), 'the conflicted copy is still on disk')
      await B.shot('s148-B-restored', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
