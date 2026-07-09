import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

// P1 / G10 — the peer is ALREADY viewing the folder when the owner changes it.
// The open FolderView must refresh on its own (event-driven, `share-files-updated`)
// — a new file appears and a removed file disappears without re-navigating.
export default async function s35 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const ownDir = path.join(workDir('own-'), 'Live')
  const mirrorDir = workDir('mirror-')
  mkdirSync(ownDir, { recursive: true })
  writeFileSync(path.join(ownDir, 'start.txt'), 'present at open')

  try {
    await r.ok('A shares "Live", B mirrors and opens the folder', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addOwnedFolder(ownDir)
      await B.waitText('Live', 60000)
      await B.mirrorShare(mirrorDir)
      await waitFor(() => existsSync(path.join(mirrorDir, 'start.txt')), 60000, 'start.txt on mirror')
      await B.openFolder('Live')
      await B.waitText('start.txt', 15000)
    })
    await r.ok('a file the owner adds appears in the already-open folder view', async () => {
      writeFileSync(path.join(ownDir, 'arrived.txt'), 'added while open')
      await B.waitText('arrived.txt', 30000)               // no re-navigation
      await B.shot('s35-B-live-added', runDir)
    })
    await r.ok('a file the owner removes disappears from the already-open folder view', async () => {
      rmSync(path.join(ownDir, 'start.txt'))
      await waitFor(async () => !(await B.hasText('start.txt')), 30000, 'removed file dropped from the open view')
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
