import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

// P1 / G8 — duplicating a file inside a shared folder. The copy has identical
// content (same hash) but a different path; both entries must publish and
// materialize as two distinct files on the mirror.
export default async function s33 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const ownDir = path.join(workDir('own-'), 'Library')
  const mirrorDir = workDir('mirror-')
  mkdirSync(ownDir, { recursive: true })
  writeFileSync(path.join(ownDir, 'orig.txt'), 'duplicate me')

  try {
    await r.ok('launch + connect + A shares "Library", B mirrors orig.txt', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addOwnedFolder(ownDir)
      await B.waitText('Library', 60000)
      await B.mirrorShare(mirrorDir)
      await waitFor(() => existsSync(path.join(mirrorDir, 'orig.txt')), 60000, 'orig.txt on mirror')
    })
    await r.ok('A duplicates the file; both copies replicate to the mirror', async () => {
      writeFileSync(path.join(ownDir, 'copy.txt'), readFileSync(path.join(ownDir, 'orig.txt')))
      await waitFor(() => existsSync(path.join(mirrorDir, 'copy.txt')), 60000, 'copy.txt materialized')
      assert(existsSync(path.join(mirrorDir, 'orig.txt')), 'original still present')
      assert(readFileSync(path.join(mirrorDir, 'copy.txt'), 'utf8') === 'duplicate me', 'copy has the right bytes')
      await B.shot('s33-B-mirror-duplicate', runDir)
    })
    await r.ok('both files show in B’s folder view', async () => {
      await B.openFolder('Library')
      await B.waitText('copy.txt', 20000)
      assert(await B.hasText('orig.txt'), 'original still listed')
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
