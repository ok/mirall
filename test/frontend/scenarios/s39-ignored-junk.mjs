import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

// P2 / G14 — OS junk and temp files (.DS_Store, *.partial) in an owned folder
// must never be published. The DEFAULT_IGNORE logic is unit-tested, but the real
// chokidar → publish path that consults it is only exercised here.
export default async function s39 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const ownDir = path.join(workDir('own-'), 'Clean')
  const mirrorDir = workDir('mirror-')
  mkdirSync(ownDir, { recursive: true })
  writeFileSync(path.join(ownDir, 'real.txt'), 'share me')
  writeFileSync(path.join(ownDir, '.DS_Store'), 'finder junk')
  writeFileSync(path.join(ownDir, 'draft.partial'), 'in-flight temp')

  try {
    await r.ok('launch + connect + A shares "Clean", B mirrors', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addOwnedFolder(ownDir)
      await B.waitText('Clean', 60000)
      await B.mirrorShare(mirrorDir)
      await waitFor(() => existsSync(path.join(mirrorDir, 'real.txt')), 60000, 'real file mirrored')
    })
    await r.ok('the junk files are never published to the mirror', async () => {
      // Give any erroneous publish time to arrive before asserting absence.
      await new Promise((res) => setTimeout(res, 3000))
      assert(!existsSync(path.join(mirrorDir, '.DS_Store')), '.DS_Store not shared')
      assert(!existsSync(path.join(mirrorDir, 'draft.partial')), '*.partial not shared')
      await B.shot('s39-B-no-junk', runDir)
    })
    await r.ok('only the real file shows in B’s folder view', async () => {
      await B.openFolder('Clean')
      await B.waitText('real.txt', 20000)
      assert(!(await B.hasText('.DS_Store')), '.DS_Store not listed')
      assert(!(await B.hasText('.partial')), '*.partial not listed')
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
