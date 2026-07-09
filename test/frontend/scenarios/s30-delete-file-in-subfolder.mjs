import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

// P0 / G5 — deletion inside a subfolder. Removing one nested file must remove
// exactly that file from the mirror and leave its siblings (and the rest of the
// tree) intact; nested deletion can take a different path than flat deletion.
export default async function s30 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const ownDir = path.join(workDir('own-'), 'Gallery')
  const mirrorDir = workDir('mirror-')
  mkdirSync(path.join(ownDir, 'album'), { recursive: true })
  writeFileSync(path.join(ownDir, 'album', 'a.txt'), 'one')
  writeFileSync(path.join(ownDir, 'album', 'b.txt'), 'two')

  try {
    await r.ok('launch + connect + A shares "Gallery", B mirrors both nested files', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addOwnedFolder(ownDir)
      await B.waitText('Gallery', 60000)
      await B.mirrorShare(mirrorDir)
      await waitFor(
        () => existsSync(path.join(mirrorDir, 'album', 'a.txt')) && existsSync(path.join(mirrorDir, 'album', 'b.txt')),
        60000, 'both nested files on mirror')
    })
    await r.ok('A deletes album/a.txt; only it leaves the mirror, album/b.txt stays', async () => {
      rmSync(path.join(ownDir, 'album', 'a.txt'))
      await waitFor(() => !existsSync(path.join(mirrorDir, 'album', 'a.txt')), 60000, 'album/a.txt gone from mirror')
      assert(existsSync(path.join(mirrorDir, 'album', 'b.txt')), 'sibling album/b.txt untouched')
      await B.shot('s30-B-mirror-nested-delete', runDir)
    })
    await r.ok('the nested deletion shows in B’s folder view', async () => {
      await B.openFolder('Gallery')
      await B.waitText('b.txt', 20000) // album is top-level → open by default, surviving sibling shows
      await waitFor(async () => !(await B.hasText('a.txt')), 20000, 'a.txt no longer listed')
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
