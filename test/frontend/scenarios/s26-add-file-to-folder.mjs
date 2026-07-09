import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

// P0 / G1 — the most basic ongoing operation: the owner drops a new file into an
// already-shared folder and it must reach the peer's folder view and a mirror's
// disk. This is the only layer that drives the real chokidar add → publish path.
export default async function s26 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const ownDir = path.join(workDir('own-'), 'Photos')
  const mirrorDir = workDir('mirror-')
  mkdirSync(ownDir, { recursive: true })
  writeFileSync(path.join(ownDir, 'a.txt'), 'first')

  try {
    await r.ok('launch + connect + A shares "Photos", B mirrors', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addOwnedFolder(ownDir)
      await B.waitText('Photos', 60000)
      await B.mirrorShare(mirrorDir)
      await waitFor(() => existsSync(path.join(mirrorDir, 'a.txt')), 60000, 'initial file on mirror')
    })
    await r.ok('A adds b.txt to the shared folder; it lands on B’s mirror', async () => {
      writeFileSync(path.join(ownDir, 'b.txt'), 'second')
      await waitFor(() => existsSync(path.join(mirrorDir, 'b.txt')), 60000, 'b.txt materialized on mirror')
      await B.shot('s26-B-mirror-has-b', runDir)
    })
    await r.ok('the new file shows in B’s folder view', async () => {
      await B.openFolder('Photos')
      await B.waitText('b.txt', 20000)
      assert(await B.hasText('a.txt'), 'original file still listed')
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
