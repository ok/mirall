import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

// REGRESSION (FIX-PAUSE-INDICATION): pausing a mirror from inside FolderView gave
// no visible signal — only the (hidden) menu item label changed. The view must
// show a paused state and clear it on resume.
export default async function s25 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const ownDir = path.join(workDir('own-'), 'Reports')
  const mirrorDir = workDir('mirror-')
  mkdirSync(ownDir, { recursive: true })
  writeFileSync(path.join(ownDir, 'q1.txt'), 'numbers')

  try {
    await r.ok('launch + connect + A shares, B mirrors and opens the folder', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addOwnedFolder(ownDir)
      await B.waitText('Reports', 60000)
      await B.mirrorShare(mirrorDir)
      await B.click({ name: 'Open Reports' })
      await B.waitText('People', 15000)
    })
    await r.ok('pausing the mirror shows a paused indication in the folder', async () => {
      await B.pauseMirror()
      await B.waitText('Syncing is paused', 15000)
      await B.shot('s25-paused', runDir)
    })
    await r.ok('resuming clears the paused indication', async () => {
      await B.resumeMirror()
      await waitFor(async () => !(await B.hasText('Syncing is paused')), 15000, 'paused banner cleared')
      await B.shot('s25-resumed', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
