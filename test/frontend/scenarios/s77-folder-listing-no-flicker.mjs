import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert } from '../assert.mjs'
import { workDir } from '../paths.mjs'

// FIX-132 (UI) — while the owner is still indexing a large folder, a browsing peer's open
// FolderView must grow monotonically and never flash the "empty folder" panel. The peer-catalog
// read can transiently return empty/partial; the renderer now keeps its last good list and merges
// (reconcileFiles) instead of a wholesale replace. Proven by: an early file stays present after a
// late file appears — i.e. the list never blanked/reset mid-index.
export default async function s77 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const ownDir = path.join(workDir('own-'), 'Index')
  const mirrorDir = workDir('mirror-')
  mkdirSync(ownDir, { recursive: true })
  const N = 60
  for (let i = 0; i < N; i++) writeFileSync(path.join(ownDir, 'f' + String(i).padStart(4, '0') + '.txt'), 'x'.repeat(64))

  try {
    await r.ok('A shares a large folder; B mirrors and opens it while it indexes', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addOwnedFolder(ownDir)
      await B.waitText('Index', 60000)
      await B.mirrorShare(mirrorDir)
      await B.openFolder('Index')
    })
    await r.ok('the listing grows monotonically and never blanks (early file survives the late one)', async () => {
      await B.waitText('f0000.txt', 30000)
      await B.waitText('f0059.txt', 60000)
      // No mid-index blank: the first file is still present after the last one arrived.
      assert(await B.hasText('f0000.txt'), 'the first file is still listed after the last one appeared')
      await B.shot('s77-B-no-flicker', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
