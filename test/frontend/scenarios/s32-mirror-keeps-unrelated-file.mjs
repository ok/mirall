import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

// P1 / G7 — the user mirrors a folder into a directory that already holds their
// own unrelated file. That file must survive the initial scan AND a later
// owner-side deletion (the mirror may only remove files it itself synced). This
// is the UI counterpart of the data-loss fix verified at test/flow/foreign-sync.
export default async function s32 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const ownDir = path.join(workDir('own-'), 'Vault')
  const mirrorDir = workDir('mirror-')
  mkdirSync(ownDir, { recursive: true })
  writeFileSync(path.join(ownDir, 'secret.txt'), 'keep me')
  writeFileSync(path.join(ownDir, 'temp.txt'), 'delete me later')
  // Bob's own file already living in the chosen mirror destination.
  writeFileSync(path.join(mirrorDir, 'bob-keepsake.txt'), 'belongs to Bob')

  try {
    await r.ok('B mirrors into a folder that already holds his own file', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addOwnedFolder(ownDir)
      await B.waitText('Vault', 60000)
      await B.mirrorShare(mirrorDir)
      await waitFor(() => existsSync(path.join(mirrorDir, 'secret.txt')) && existsSync(path.join(mirrorDir, 'temp.txt')),
        60000, 'share files materialized')
      assert(existsSync(path.join(mirrorDir, 'bob-keepsake.txt')), "Bob's file survived the initial scan")
    })
    await r.ok('an owner deletion removes only the share file, never Bob’s own file', async () => {
      rmSync(path.join(ownDir, 'temp.txt'))
      await waitFor(() => !existsSync(path.join(mirrorDir, 'temp.txt')), 60000, 'owner-deleted file removed')
      assert(existsSync(path.join(mirrorDir, 'bob-keepsake.txt')), "Bob's own file is untouched")
      assert(existsSync(path.join(mirrorDir, 'secret.txt')), 'the other share file is untouched')
      await B.shot('s32-B-mirror-keepsake-survives', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
