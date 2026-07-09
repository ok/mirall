import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

const sleep = (ms) => new Promise((res) => setTimeout(res, ms))

// B3 — while the owner indexes a big LOOSE file, the peer's row surfaces "Preparing…"
// (owner indexing, pre-availability), then settles to "Available" once the owner's hash
// lands, and downloads cleanly to "On your device". The loose analogue of the folder
// no-flicker guarantee (s77). Catching the transient "Preparing…" is best-effort (fast
// hashing can beat the AX poll); the hard guarantees are the settle to Available, the
// successful download, and that the row never shows a broken "Failed" during indexing.
export default async function s86 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const dir = workDir('loose-preparing-')
  const big = path.join(dir, 'reel.bin')
  mkdirSync(dir, { recursive: true })
  writeFileSync(big, Buffer.alloc(256 * 1024 * 1024, 15))
  const landed = path.join(B.downloadFolder, 'reel.bin')

  let sawPreparing = false
  try {
    await r.ok('launch + connect', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
    })

    await r.ok('A adds a big loose file; B surfaces Preparing then settles to Available', async () => {
      await A.addFile(big)
      const dl = Date.now() + 20000
      while (Date.now() < dl) {
        if (await B.hasText('Preparing')) { sawPreparing = true; break }
        if (await B.hasText('Available')) break // owner indexing already finished
        await sleep(250)
      }
      if (sawPreparing) await B.shot('s86-B-preparing', runDir)
      assert(!(await B.hasText('Failed')), 'the row never shows Failed while the owner indexes')
      await B.waitText('Available', 90000)
      await B.shot('s86-B-available', runDir)
    })

    await r.ok('B downloads it to completion', async () => {
      await B.click({ role: 'button', name: 'Download', last: true })
      await waitFor(() => existsSync(landed), 120000, 'reel.bin landed on B')
      await B.waitText('On your device', 30000)
      await B.shot('s86-B-downloaded', runDir)
    })

    console.log(`s86: peer "Preparing…" caught: ${sawPreparing}`)
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
