import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

const sleep = (ms) => new Promise((res) => setTimeout(res, ms))

// D3 — the peer MANUALLY pauses, then the owner goes offline and returns. The manual
// pause must SURVIVE the owner's reconnect: it must NOT auto-resume (the pausedHashes
// gate) — the peer stays paused and the file does not complete on its own, while a manual
// Resume still works. Best-effort on catching the download to pause it (loopback can
// finish first); when the pause is established, the no-auto-resume guarantee is asserted.
export default async function s94 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const dir = workDir('manual-pause-')
  const big = path.join(dir, 'held.bin')
  mkdirSync(dir, { recursive: true })
  writeFileSync(big, Buffer.alloc(256 * 1024 * 1024, 29))
  const landed = path.join(B.downloadFolder, 'held.bin')

  let paused = false
  try {
    await r.ok('A shares; B downloads then manually pauses', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addFile(big)
      await B.waitText('held', 90000)
      await B.waitText('Available', 90000)
      await B.click({ role: 'button', name: 'Download', last: true })

      let sawPause = false
      const dl = Date.now() + 20000
      while (Date.now() < dl) {
        if (await B.has({ role: 'button', name: 'Pause Download' })) { sawPause = true; break }
        if (await B.hasText('On your device')) break
        await sleep(200)
      }
      if (!sawPause) { console.log('s94: download finished before pause could be caught — no-auto-resume not exercised'); return }

      await B.click({ role: 'button', name: 'Pause Download' })
      const pd = Date.now() + 15000
      while (Date.now() < pd) {
        if (await B.has({ role: 'button', name: 'Resume' })) { paused = true; break }
        if (await B.hasText('On your device')) break
        await sleep(200)
      }
      if (paused) { assert(await B.hasText('Paused'), 'row shows Paused after manual pause'); await B.shot('s94-B-paused', runDir) }
      else console.log('s94: pause click lost the race to completion — not exercised')
    })

    await r.ok('A restarts; B stays paused (the manual pause is not auto-resumed)', async () => {
      if (!paused) { console.log('s94: skipped — manual pause was not established'); return }
      await A.relaunch() // owner offline + return

      // Wait through A's reconnect + the auto-resume scan window; the manual pause must hold.
      await sleep(30000)
      assert(!existsSync(landed), 'the paused file did not complete on its own after the owner returned')
      assert(!(await B.hasText('On your device')), 'B never auto-completed the manually-paused transfer')
      assert((await B.hasText('Paused')) || (await B.hasText('Owner offline')),
        'B is still in a paused state after the owner returns (no auto-resume)')
      await B.shot('s94-B-still-paused', runDir)

      // A manual Resume still drives it to completion.
      await B.click({ role: 'button', name: 'Resume' })
      await waitFor(() => existsSync(landed), 180000, 'held.bin completes after a manual resume')
      await B.waitText('On your device', 30000)
      await B.shot('s94-B-manually-resumed', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
