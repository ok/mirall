import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

// G1 — re-share idempotency: a loose file shared, unshared, then added again shares
// cleanly (no stuck tombstone blocks the re-add). The peer sees it, loses it, then sees it
// again. A share/unshare/re-share visibility flow, not a transfer — so a small file.
export default async function s100 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const dir = workDir('reshare-')
  const file = path.join(dir, 'cycle.txt')
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, 'a file that gets shared, unshared, and shared again')

  try {
    await r.ok('A shares cycle.txt; B sees it', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addFile(file)
      await A.waitText('cycle', 30000)
      await B.waitText('cycle', 60000)
    })

    await r.ok('A unshares it; B sees it gone', async () => {
      await A.focus()
      await A.click({ role: 'button', name: 'Unshare from Space', last: true })
      await A.waitText('Remove', 8000)
      await A.click({ role: 'button', name: 'Remove File', last: true })
      await waitFor(async () => !(await A.hasText('cycle')), 20000, 'gone for owner')
      await waitFor(async () => !(await B.hasText('cycle')), 60000, 'gone for peer')
    })

    await r.ok('A re-adds the same file; B sees it again', async () => {
      await A.focus()
      await A.addFile(file)
      await A.waitText('cycle', 30000)
      await B.waitText('cycle', 60000)
      await B.shot('s100-B-reshared', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
