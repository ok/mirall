import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert } from '../assert.mjs'
import { workDir } from '../paths.mjs'

// D1 — the owner goes offline while a peer is mid-download. The peer's loose row flips to
// "Owner offline" (paused-offline) and the file does not complete while the owner is gone.
// (s41 is the at-rest folder twin; this is the loose, mid-transfer case.) A is killed (a
// disconnect, not a leave-space); detection rides swarm keepalive (~tens of seconds), so
// the wait has headroom.
export default async function s92 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const dir = workDir('owner-offline-')
  const big = path.join(dir, 'stream.bin')
  mkdirSync(dir, { recursive: true })
  writeFileSync(big, Buffer.alloc(256 * 1024 * 1024, 19))
  const landed = path.join(B.downloadFolder, 'stream.bin')

  try {
    await r.ok('A shares a big loose file; B starts downloading', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addFile(big)
      await B.waitText('stream', 90000)
      await B.waitText('Available', 90000)
      await B.click({ role: 'button', name: 'Download', last: true })
      await B.waitText('Downloading', 60000)
    })

    await r.ok('A goes offline mid-download → B shows "Owner offline", nothing completes', async () => {
      await A.kill() // disconnect the owner (not returning in this scenario)
      await B.waitText('Owner offline', 120000)
      assert(!existsSync(landed), 'the file does not complete while the owner is offline')
      await B.shot('s92-B-owner-offline', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
