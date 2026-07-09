import { mkdirSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

// P0 / G4 — the owner moves a file from the folder root into a subfolder. A move
// is unlink(old)+add(new); a mishandled pair leaves a stale duplicate on the
// mirror or drops the file entirely. The mirror must end with the file ONLY at
// the new nested path.
export default async function s29 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const ownDir = path.join(workDir('own-'), 'Docs')
  const mirrorDir = workDir('mirror-')
  mkdirSync(ownDir, { recursive: true })
  writeFileSync(path.join(ownDir, 'doc.txt'), 'movable')

  try {
    await r.ok('launch + connect + A shares "Docs", B mirrors doc.txt at root', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addOwnedFolder(ownDir)
      await B.waitText('Docs', 60000)
      await B.mirrorShare(mirrorDir)
      await waitFor(() => existsSync(path.join(mirrorDir, 'doc.txt')), 60000, 'doc.txt at mirror root')
    })
    await r.ok('A moves doc.txt into archive/; the mirror reflects the move with no duplicate', async () => {
      mkdirSync(path.join(ownDir, 'archive'), { recursive: true })
      renameSync(path.join(ownDir, 'doc.txt'), path.join(ownDir, 'archive', 'doc.txt'))
      await waitFor(() => existsSync(path.join(mirrorDir, 'archive', 'doc.txt')), 60000, 'new nested path present')
      await waitFor(() => !existsSync(path.join(mirrorDir, 'doc.txt')), 60000, 'old root path removed (no stale copy)')
      await B.shot('s29-B-mirror-moved', runDir)
    })
    await r.ok('B’s folder view shows the file only at its new path', async () => {
      await B.openFolder('Docs')
      await B.waitText('doc.txt', 20000) // archive is top-level → open by default, file shows by basename
      assert(await B.hasText('archive'), 'the file sits under the archive subfolder row')
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
