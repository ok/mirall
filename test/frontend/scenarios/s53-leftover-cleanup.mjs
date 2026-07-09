import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert } from '../assert.mjs'
import { workDir } from '../paths.mjs'

// End-to-end "Free up space" through the UI. Bob browses Alice's overlay folder
// (her catalog replicates into his store) and then leaves, leaving reclaimable
// state behind. Bob opens Storage and runs the single Free up space action, which
// compacts the overlay index and purges orphaned metadata, reporting what it freed.
export default async function s53 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const ownDir = path.join(workDir('own-'), 'Shared')
  mkdirSync(ownDir, { recursive: true })
  writeFileSync(path.join(ownDir, 'doc.txt'), 'SHARED')

  try {
    await r.ok('connect; Alice shares an overlay folder; Bob browses it', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addOwnedFolder(ownDir)
      await B.waitText('Shared', 60000)
      // Open the folder so Alice's catalog replicates into Bob's store — the
      // core that survives as leftover after he leaves.
      await B.openFolder('Shared')
      await B.waitText('doc.txt', 30000)
    })
    await r.ok('Bob leaves the space', async () => {
      await B.back()
      await B.leaveSpace()
    })
    await r.ok('Bob opens Storage and expands the breakdown', async () => {
      await B.openSettings()
      await B.click({ contains: 'Storage' })
      await B.waitText('Download Folder', 10000)
      await B.click({ role: 'button', name: 'Show details' })
      await B.waitText('Shared-file index', 10000)
      assert(await B.hasText('App database'), 'the measured breakdown renders')
      await B.shot('s53-storage-before', runDir)
    })
    await r.ok('Free up space reports the reclaimed amount', async () => {
      await B.click({ role: 'button', name: 'Free up space' })
      // The action compacts the index, purges orphaned metadata, then compactStore()s.
      await B.waitText('Freed', 60000)
      assert(await B.hasText('Freed'), 'the status region announces the reclaimed amount')
      await B.shot('s53-storage-after', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
