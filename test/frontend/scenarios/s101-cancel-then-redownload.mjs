import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

const sleep = (ms) => new Promise((res) => setTimeout(res, ms))

// G2 — cancel a loose download mid-flight, then re-download: it completes with no stale
// partial from the first attempt (the re-downloaded file is full-size on disk). 256 MB
// for a comfortable mid-flight cancel window; if the first attempt finishes before the
// cancel is caught, the retry isn't exercised (logged) and the full-size check still holds.
export default async function s101 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const dir = workDir('cancel-retry-')
  const big = path.join(dir, 'retry.bin')
  mkdirSync(dir, { recursive: true })
  const size = 256 * 1024 * 1024
  writeFileSync(big, Buffer.alloc(size, 53))
  const landed = path.join(B.downloadFolder, 'retry.bin')

  let sawCancel = false
  try {
    await r.ok('A shares a big loose file; B sees it Available', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addFile(big)
      await B.waitText('retry', 90000)
      await B.waitText('Available', 90000)
    })

    await r.ok('B downloads then cancels mid-flight', async () => {
      await B.click({ role: 'button', name: 'Download', last: true })
      const dl = Date.now() + 20000
      while (Date.now() < dl) {
        if (await B.has({ role: 'button', name: 'Cancel' })) { sawCancel = true; break }
        if (await B.hasText('On your device')) break
        await sleep(200)
      }
      if (sawCancel) {
        await B.click({ role: 'button', name: 'Cancel' })
        await waitFor(async () => await B.hasText('Available'), 20000, 'reverted to Available after cancel')
      } else {
        console.log('s101: cancel window missed on the first attempt')
      }
      await B.shot('s101-B-cancelled', runDir)
    })

    await r.ok('B re-downloads → completes full-size, no stale partial', async () => {
      if (!sawCancel && (await B.hasText('On your device'))) {
        console.log('s101: first download completed before cancel — retry not exercised')
        assert(statSync(landed).size === size, 'the downloaded file is full-size')
        return
      }
      await B.waitText('Available', 30000)
      await B.click({ role: 'button', name: 'Download', last: true })
      await waitFor(() => existsSync(landed), 180000, 'retry.bin lands on re-download')
      await B.waitText('On your device', 30000)
      assert(statSync(landed).size === size, 're-downloaded file is full-size (no stale partial)')
      await B.shot('s101-B-redownloaded', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
