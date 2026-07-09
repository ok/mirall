import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

// D2 — the owner goes offline LONG ENOUGH for the peer to notice, then returns; the peer
// auto-resumes and completes. The gap matters: a no-gap relaunch can come back before the peer
// ever registered the outage, leaving the interrupted fetch with no offline→online edge to
// trigger auto-resume (that quick-restart stall is a separate finding — see the plan). So:
// quit A (keep its store), wait until B shows "Owner offline", then boot A back on the same
// store. Uses the quit()/launch harness (kill() would wipe the store). Hard guarantee:
// completion after A returns.
export default async function s93 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const dir = workDir('owner-return-')
  const big = path.join(dir, 'resume.bin')
  mkdirSync(dir, { recursive: true })
  writeFileSync(big, Buffer.alloc(256 * 1024 * 1024, 23))
  const landed = path.join(B.downloadFolder, 'resume.bin')

  try {
    await r.ok('A shares a big loose file; B starts downloading', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addFile(big)
      await B.waitText('resume', 90000)
      await B.waitText('Available', 90000)
      await B.click({ role: 'button', name: 'Download', last: true })
      await B.waitText('Downloading', 60000)
    })

    await r.ok('A goes offline until B notices, then returns → B auto-resumes and completes', async () => {
      await A.quit() // stop, keep the store — a controllable outage gap
      await B.waitText('Owner offline', 120000) // B registers the outage (the auto-resume edge)
      await B.shot('s93-B-owner-offline', runDir)

      await A.launch({ onboard: false }) // the owner returns on the same store and re-serves
      // On reconnect, B's auto-resume drives the interrupted transfer to completion.
      await waitFor(() => existsSync(landed), 240000, 'resume.bin lands after the owner returns')
      await B.waitText('On your device', 30000)
      await B.shot('s93-B-resumed', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
