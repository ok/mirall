import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

// P2 / G16 — when the owner goes offline, the peer's open folder view must
// surface it: an offline banner appears and the file's status drops from
// "Available" to "Not available". (The "owner returns → catches up" half needs a
// suspend/relaunch the frontend harness doesn't support — `kill()` wipes the
// store — and is asserted at the data layer: test/flow/{offline-transfer,
// resume-transfer,foreign-sync}.) Hard-kill disconnect detection rides swarm
// keepalive (~tens of seconds), so this scenario needs headroom.
export default async function s41 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const ownDir = path.join(workDir('own-'), 'Cloud')
  mkdirSync(ownDir, { recursive: true })
  writeFileSync(path.join(ownDir, 'doc.txt'), 'remote only')

  try {
    await r.ok('A shares "Cloud"; B opens it and sees the file as Available', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addOwnedFolder(ownDir)
      await B.waitText('Cloud', 60000)
      await B.openFolder('Cloud')
      await B.waitText('Available', 20000)
    })
    await r.ok('when the owner goes offline, the open folder reflects it', async () => {
      await A.kill()
      await B.waitText('offline', 90000)                  // the offline banner ("Alice is offline …")
      await waitFor(() => B.hasText('Not available'), 30000, 'file status dropped to Not available')
      await B.shot('s41-B-owner-offline', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
