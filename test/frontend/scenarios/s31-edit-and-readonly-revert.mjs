import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

const read = (p) => { try { return readFileSync(p, 'utf8') } catch { return null } }

// P0 / G6 — two guarantees:
//  (1) an owner edit changes the file's content on the mirror (hash change →
//      re-download), not just its presence;
//  (2) the read-only promise: if the user edits a mirrored file locally, the
//      next sync reverts it to the owner's version. The mirror has no watcher in
//      v1 and a local-only edit never moves the owner's catalog version, so the
//      walk that restores the file is the one the folder listing asks for when it
//      sees a drifted copy. Bob therefore opens the folder after tampering;
//      without that the revert waits on the full-walk backstop (issue #462).
export default async function s31({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const ownDir = path.join(workDir('own-'), 'Notes')
  const mirrorDir = workDir('mirror-')
  const mirrorFile = path.join(mirrorDir, 'note.txt')
  mkdirSync(ownDir, { recursive: true })
  writeFileSync(path.join(ownDir, 'note.txt'), 'v1')

  try {
    await r.ok('launch + connect + A shares "Notes", B mirrors note.txt (v1)', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addOwnedFolder(ownDir)
      await B.waitText('Notes', 60000)
      await B.mirrorShare(mirrorDir)
      await waitFor(() => read(mirrorFile) === 'v1', 60000, 'v1 on mirror')
    })
    await r.ok('an owner edit updates the file content on the mirror', async () => {
      writeFileSync(path.join(ownDir, 'note.txt'), 'v2-edited-by-owner')
      await waitFor(() => read(mirrorFile) === 'v2-edited-by-owner', 60000, 'edited content propagated')
      await B.shot('s31-B-mirror-edited', runDir)
    })
    await r.ok('a local edit on the read-only mirror is reverted on the next sync', async () => {
      writeFileSync(mirrorFile, 'bob-tampered')                 // user edits a read-only mirror file
      await B.focus()
      await B.openFolder('Notes')
      await waitFor(() => read(mirrorFile) === 'v2-edited-by-owner', 50000,
        "mirror reverted Bob's edit to the owner's version")
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
