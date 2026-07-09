import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert } from '../assert.mjs'
import { workDir } from '../paths.mjs'

const sleep = (ms) => new Promise((res) => setTimeout(res, ms))

// F3 — the DOWNLOADER leaves the space mid-download. Its in-flight transfer is torn down
// (looseCancelSpace): no full file lands, no late completion re-writes purged rows, and
// the peer returns to the space list. 256 MB keeps the transfer in flight at leave time.
export default async function s99 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const dir = workDir('downloader-leaves-')
  const big = path.join(dir, 'depart.bin')
  mkdirSync(dir, { recursive: true })
  writeFileSync(big, Buffer.alloc(256 * 1024 * 1024, 47))
  const landed = path.join(B.downloadFolder, 'depart.bin')

  try {
    await r.ok('A shares a big loose file; B starts downloading', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addFile(big)
      await B.waitText('depart', 90000)
      await B.waitText('Available', 90000)
      await B.click({ role: 'button', name: 'Download', last: true })
      await B.waitText('Downloading', 60000)
    })

    await r.ok('B leaves the space mid-download → transfer purged, no file lands', async () => {
      await B.focus()
      await B.leaveSpace() // More → Leave Space → confirm; lands back on the space list
      await sleep(15000) // give any late completion a chance to (wrongly) land
      assert(!existsSync(landed), 'no full file lands after the downloader leaves the space mid-transfer')
      await B.shot('s99-B-left', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
