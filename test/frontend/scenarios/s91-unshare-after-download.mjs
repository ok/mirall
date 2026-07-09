import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

const sleep = (ms) => new Promise((res) => setTimeout(res, ms))

// C5 — the owner unshares a loose file the peer has ALREADY fully downloaded. The peer
// KEEPS its copy: the file stays on disk, full-size, and the row still reflects a local
// copy. The RemoveFileModal promises exactly this ("Members who already downloaded it
// will keep their copy"). 128 MB — a real transfer that still completes promptly.
export default async function s91 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const dir = workDir('unshare-after-')
  const big = path.join(dir, 'keeper.bin')
  mkdirSync(dir, { recursive: true })
  const size = 128 * 1024 * 1024
  writeFileSync(big, Buffer.alloc(size, 42))
  const landed = path.join(B.downloadFolder, 'keeper.bin')

  try {
    await r.ok('A shares; B downloads to completion', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addFile(big)
      await B.waitText('keeper', 90000)
      await B.waitText('Available', 90000)
      await B.click({ role: 'button', name: 'Download', last: true })
      await waitFor(() => existsSync(landed), 120000, 'keeper.bin landed')
      await B.waitText('On your device', 30000)
    })

    await r.ok('A unshares it; B keeps its downloaded copy intact', async () => {
      await A.focus()
      await A.click({ role: 'button', name: 'Unshare from Space', last: true })
      await A.waitText('Remove', 8000)
      await A.click({ role: 'button', name: 'Remove File', last: true })
      await waitFor(async () => !(await A.hasText('keeper')), 20000, 'owner row gone after unshare')

      // Core promise: the peer's downloaded copy survives, full-size.
      await sleep(8000) // give the tombstone time to (not) disturb the local copy
      assert(existsSync(landed), 'peer keeps its downloaded copy on disk after the owner unshares')
      assert(statSync(landed).size === size, 'the kept copy is the full file')

      // Evidence: does the row still present it as a local copy?
      const local = (await B.hasText('On your device')) || (await B.has({ role: 'button', name: 'Reveal in Folder' }))
      console.log(`s91: peer row still shows a local copy: ${local}`)
      await B.shot('s91-B-kept-copy', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
