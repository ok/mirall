import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

// REGRESSION (FIX-MIRROR-CONTROLS): a mirrored folder must never expose per-file
// transfer controls. A Download button on a mirror row pulled a stray copy into
// the Downloads dir instead of the mount; Pause/Cancel/Resume/Discard likewise
// don't belong on an auto-syncing folder. Reveal on synced files stays.
export default async function s50 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const ownDir = path.join(workDir('own-'), 'Reports')
  const mirrorDir = workDir('mirror-')
  mkdirSync(ownDir, { recursive: true })
  writeFileSync(path.join(ownDir, 'a.txt'), 'first')

  try {
    await r.ok('A shares "Reports"; B mirrors and the first file syncs', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addOwnedFolder(ownDir)
      await B.waitText('Reports', 60000)
      await B.mirrorShare(mirrorDir)
      await waitFor(() => existsSync(path.join(mirrorDir, 'a.txt')), 60000, 'a.txt synced to mirror')
      await B.openFolder('Reports')
      await B.waitText('a.txt', 20000)
    })

    await r.ok('a synced row offers Reveal but NO manual transfer controls', async () => {
      assert(await B.has({ role: 'button', name: 'Reveal in Folder' }), 'synced file is revealable')
      assert(!(await B.has({ role: 'button', name: 'Pause Download' })), 'no Pause on a mirror row')
      assert(!(await B.has({ role: 'button', name: 'Cancel' })), 'no Cancel on a mirror row')
    })

    await r.ok('a remote (paused-mirror) row shows NO Download button', async () => {
      await B.pauseMirror()
      await B.waitText('Syncing is paused', 15000)
      // A adds a file while the mirror is paused → it lists as remote on B, a
      // stable state with no auto-download race.
      writeFileSync(path.join(ownDir, 'b.txt'), 'second')
      await B.waitText('b.txt', 30000)
      assert(!(await B.has({ role: 'button', name: 'Download' })), 'a mirrored remote file has NO Download button')
      await B.shot('s50-B-no-download', runDir)
    })

    await r.ok('resuming the mirror syncs b.txt; still no manual controls', async () => {
      await B.resumeMirror()
      await waitFor(() => existsSync(path.join(mirrorDir, 'b.txt')), 60000, 'b.txt synced after resume')
      await B.waitText('b.txt', 20000)
      assert(!(await B.has({ role: 'button', name: 'Download' })), 'no Download after sync either')
      await B.shot('s50-B-synced', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
