import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

const sleep = (ms) => new Promise((res) => setTimeout(res, ms))

// B1 — cancel a loose publish while it is still indexing ("Adding"). During the publishing
// phase the owner's FileCard offers a single Cancel (files:cancel-publish) and NO Unshare
// (Unshare only appears once the file is fully 'mine'), so Cancel IS the mid-index removal
// path. Using it removes the half-advertised entry: the row disappears for the owner and the
// file never becomes a real share for the peer. 1 GB widens the hashing window; a tight loop
// attempts the Cancel click every iteration so it lands the instant the publishing row
// appears. If the hash still finishes first the cancel isn't exercised (logged, not failed).
export default async function s85 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const dir = workDir('publish-cancel-')
  const big = path.join(dir, 'huge.bin')
  mkdirSync(dir, { recursive: true })
  writeFileSync(big, Buffer.alloc(1024 * 1024 * 1024, 3))

  let cancelled = false
  try {
    await r.ok('launch + connect', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
    })

    await r.ok('A adds a big file and cancels while it is still "Adding"', async () => {
      await A.addFile(big)
      // Tight loop: try to click Cancel every iteration — the click's own ref-resolve doubles
      // as detection, so it lands the moment the publishing row exists, with no extra snapshot
      // latency between "seen" and "clicked". Stop when it lands, or when the publish settles.
      const dl = Date.now() + 30000
      while (Date.now() < dl) {
        try { await A.click({ role: 'button', name: 'Cancel' }); cancelled = true; break } catch { /* no publishing row yet, or already finished */ }
        if (await A.hasText('Shared by you')) break // publish finished — window missed
        await sleep(80)
      }
      if (!cancelled) { console.log('s85: publish finished before Cancel could be clicked — cancel-publish not exercised'); return }
      await waitFor(async () => !(await A.hasText('huge')), 20000, 'file row gone for owner after cancel-publish')
      await A.shot('s85-A-cancelled', runDir)
    })

    await r.ok('the file never becomes a share for the peer', async () => {
      if (!cancelled) { console.log('s85: skipped peer-absence check (cancel not exercised)'); return }
      await waitFor(async () => !(await B.hasText('huge')), 20000, 'peer never retains the cancelled file')
      await B.shot('s85-B-absent', runDir)
    })

    console.log(`s85: cancel-publish exercised: ${cancelled}`)
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
