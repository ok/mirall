import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

// P2 / G13 — two owned folders coexist in one space and sync independently: a
// mirror of one keeps updating after a second folder is shared (each folder has
// its own watcher + mount). (Same-named folders from two different owners is a
// per-owner name-uniqueness property enforced in the worker and covered at
// test/integration/share-registry — it can't be driven here because two
// identically-named cards expose ambiguous "Open <name>" selectors.)
export default async function s38 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const alphaDir = path.join(workDir('own-'), 'Alpha')
  const betaDir = path.join(workDir('own-'), 'Beta')
  const mirrorDir = workDir('mirror-')
  mkdirSync(alphaDir, { recursive: true })
  mkdirSync(betaDir, { recursive: true })
  writeFileSync(path.join(alphaDir, 'a.txt'), 'alpha one')
  writeFileSync(path.join(betaDir, 'b.txt'), 'beta one')

  try {
    await r.ok('A shares "Alpha"; B mirrors it', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addOwnedFolder(alphaDir)
      await B.waitText('Alpha', 60000)
      await B.mirrorShare(mirrorDir)                 // only Alpha exists → unambiguous card menu
      await waitFor(() => existsSync(path.join(mirrorDir, 'a.txt')), 60000, 'Alpha mirrored')
    })
    await r.ok('A shares a second folder "Beta"; B sees both', async () => {
      await A.addOwnedFolder(betaDir)
      await B.waitText('Beta', 60000)
      assert(await B.hasText('Alpha'), 'Alpha card still present alongside Beta')
    })
    await r.ok('Alpha keeps syncing independently after Beta is added', async () => {
      writeFileSync(path.join(alphaDir, 'a2.txt'), 'alpha two')
      await waitFor(() => existsSync(path.join(mirrorDir, 'a2.txt')), 60000, 'Alpha mirror still live')
      assert(!existsSync(path.join(mirrorDir, 'b.txt')), 'Beta (unmirrored) did not leak into Alpha’s mirror')
      await B.shot('s38-B-two-folders', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
