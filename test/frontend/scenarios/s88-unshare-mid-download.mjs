import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

const sleep = (ms) => new Promise((res) => setTimeout(res, ms))

// C1 [characterization] — the owner UNSHARES a loose file while a peer is mid-download.
// Asserts the invariants true both now AND after the (currently-missing) loose
// TRANSFER_REMOVED terminal state lands: the owner's row is gone, and the peer NEVER
// falsely completes removed content — no full file lands and the row never claims
// "On your device". The peer's exact degraded state today (paused + silent auto-retry,
// with no removed-error) is captured as evidence/log, not asserted, so this stays green
// across the fix. 256 MB keeps the peer comfortably mid-flight. See
// archive/plan-peer-deletion-and-cache-reclaim.md (loose overlay gap).
export default async function s88 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const dir = workDir('unshare-mid-')
  const big = path.join(dir, 'payload.bin')
  mkdirSync(dir, { recursive: true })
  writeFileSync(big, Buffer.alloc(256 * 1024 * 1024, 7))
  const landed = path.join(B.downloadFolder, 'payload.bin')

  try {
    await r.ok('A shares a big loose file; B starts downloading', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addFile(big)
      await A.waitText('payload', 60000)
      await B.waitText('payload', 90000)
      await B.waitText('Available', 90000)
      await B.click({ role: 'button', name: 'Download', last: true })
      await B.waitText('Downloading', 60000)
    })

    await r.ok('A unshares the file mid-download → the owner row is gone', async () => {
      await A.focus()
      await A.click({ role: 'button', name: 'Unshare from Space', last: true })
      await A.waitText('Remove', 8000)
      await A.click({ role: 'button', name: 'Remove File', last: true })
      await waitFor(async () => !(await A.hasText('payload')), 20000, 'file row gone for owner')
      await A.shot('s88-A-unshared', runDir)
    })

    await r.ok('the peer never falsely completes the removed content', async () => {
      // Give the removal time to reach B and any auto-retry to spin, then prove B has
      // NOT completed: no full file on disk, and the row never claims "On your device".
      await sleep(15000)
      assert(!existsSync(landed), 'no file landed on the peer after the source was unshared mid-download')
      assert(!(await B.hasText('On your device')), 'peer row never claims the removed content is on-device')

      // Evidence: today B degrades to paused/silent-retry with no removed-error (the gap).
      let observed = 'other'
      if (await B.hasText('Owner offline')) observed = 'paused-offline'
      else if (await B.hasText('Paused')) observed = 'paused-interrupted'
      else if (await B.hasText('Failed')) observed = 'error'
      else if (await B.hasText('Downloading')) observed = 'still-downloading'
      else if (await B.hasText('Available')) observed = 'remote'
      console.log(`s88: peer state after mid-download unshare = ${observed} (ideal: a removed/error terminal state)`)
      await B.shot('s88-B-after-unshare', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
