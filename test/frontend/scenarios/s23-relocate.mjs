import { mkdirSync, writeFileSync, renameSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport } from '../assert.mjs'
import { workDir } from '../paths.mjs'

// Relocate an owned folder through the UI: after the source moves on disk the
// share shows "missing on disk", and Locate re-points it to the new location.
// Best-effort — driving the native re-pick after a mount-point-gone state is
// timing-sensitive; the no-churn guarantee itself is asserted at flow/relocate.
export default async function s23 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const ownDir = path.join(workDir('own-'), 'Reports')
  const movedDir = path.join(workDir('moved-'), 'Reports')
  mkdirSync(ownDir, { recursive: true })
  writeFileSync(path.join(ownDir, 'q1.txt'), 'numbers')

  try {
    await r.ok('launch + connect + share', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addOwnedFolder(ownDir)
      await B.waitText('Reports', 60000)
    })
    await r.ok('moving the source on disk surfaces the missing-on-disk state', async () => {
      renameSync(ownDir, movedDir)
      await A.waitText('missing on disk', 40000)
      await A.shot('s23-missing', runDir)
    })
    await r.ok('Locate re-points the share to the new location', async () => {
      await A.click({ name: 'More', last: true })
      await new Promise((res) => setTimeout(res, 400))
      await A.click({ name: 'Locate folder…' })
      await A.nativeChoosePath(movedDir)
      await A.waitText('Reconnected', 15000)
      await A.shot('s23-relocated', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
