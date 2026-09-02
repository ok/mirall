import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

// REGRESSION (FIX-UNMOUNT-NAV): unmounting a mirror from inside FolderView used
// to call onBack() and jump to the space view. Unmounting only reverts the share
// to a browse folder (it still exists), so the user must stay in the folder,
// which now shows the browse affordances.
export default async function s24 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const ownDir = path.join(workDir('own-'), 'Reports')
  const mirrorDir = workDir('mirror-')
  mkdirSync(ownDir, { recursive: true })
  writeFileSync(path.join(ownDir, 'q1.txt'), 'numbers')

  try {
    await r.ok('launch + connect + A shares, B mirrors', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addOwnedFolder(ownDir)
      await B.waitText('Reports', 60000)
      await B.mirrorShare(mirrorDir)
    })
    await r.ok('B opens the mirrored folder', async () => {
      await B.click({ name: 'Open Reports' })
      await B.waitText('People', 15000)
    })
    await r.ok('unmounting from the folder stays in the folder as a browse share', async () => {
      await B.unmountShare()
      await waitFor(
        async () => (await B.hasText('People')) && (await B.hasText('Mirror to Disk')),
        15000,
        'stayed in folder view, reverted to browse',
      )
      await B.shot('s24-after-unmount', runDir)
    })
    await r.ok('the file status pills refresh from on-device to available', async () => {
      await waitFor(async () => B.hasText('Available'), 30000, 'pills refreshed to the browse state')
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
