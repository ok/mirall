import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert } from '../assert.mjs'
import { workDir } from '../paths.mjs'

const sleep = (ms) => new Promise((res) => setTimeout(res, ms))

// F2 — the owner LEAVES the space entirely while a peer is downloading. The space teardown
// (looseCancelSpace / overlayCancelSpace) stops serving: the peer's transfer does not
// complete (no full file lands) and the owner returns to the space list. 256 MB keeps the
// peer mid-flight at the moment of leaving.
export default async function s98 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const dir = workDir('owner-leaves-')
  const big = path.join(dir, 'exit.bin')
  mkdirSync(dir, { recursive: true })
  writeFileSync(big, Buffer.alloc(512 * 1024 * 1024, 43))
  const landed = path.join(B.downloadFolder, 'exit.bin')

  try {
    await r.ok('A shares a big loose file; B starts downloading', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addFile(big)
      await B.waitText('exit', 90000)
      await B.waitText('Available', 90000)
      await B.click({ role: 'button', name: 'Download', last: true })
      await B.waitText('Downloading', 60000)
    })

    await r.ok('A leaves the space mid-serve → B does not complete, no orphan', async () => {
      await A.focus()
      await A.leaveSpace() // More → Leave Space → confirm; lands back on the space list
      await sleep(15000)
      assert(!existsSync(landed), 'no full file lands after the owner leaves the space mid-serve')
      await A.shot('s98-A-left', runDir)
      await B.shot('s98-B-after-owner-left', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
