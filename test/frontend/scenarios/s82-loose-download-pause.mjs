import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

const sleep = (ms) => new Promise((res) => setTimeout(res, ms))

// A1 — the LOOSE FileCard download exposes the same Pause/Resume controls the
// folder-view row does (s48), on a different surface: the space-root list, not a
// FolderView — its own a11y guarantee per row. 256 MB widens the mid-flight window
// so we usually catch the running/paused controls; loopback can still finish inside
// the AX poll, so the paused round-trip is best-effort and a lost race is not a
// failure. The hard guarantee is the file landing "On your device"; the
// pause→resume correctness itself is owned by test/flow/loose-pause-resume.
export default async function s82 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const dir = workDir('loose-pause-')
  const big = path.join(dir, 'payload.bin')
  mkdirSync(dir, { recursive: true })
  writeFileSync(big, Buffer.alloc(256 * 1024 * 1024, 5))
  const landed = path.join(B.downloadFolder, 'payload.bin')

  let sawPause = false
  let sawResume = false
  try {
    await r.ok('A shares a big loose file; B sees it Available', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addFile(big)
      await A.waitText('payload', 60000)
      await B.waitText('payload', 90000)
      await B.waitText('Available', 90000)
    })

    await r.ok('B downloads; the pause/resume round-trip runs when the race allows', async () => {
      await B.click({ role: 'button', name: 'Download', last: true })

      // Best-effort: catch the running row's Pause control. Bail when Pause shows OR
      // the transfer already finished (fast loopback). Not finding Pause is a lost
      // race, not a failure.
      const dl = Date.now() + 20000
      while (Date.now() < dl) {
        if (await B.has({ role: 'button', name: 'Pause Download' })) { sawPause = true; break }
        if (await B.hasText('On your device')) break
        await sleep(200)
      }

      if (sawPause) {
        await B.click({ role: 'button', name: 'Pause Download' })
        await B.shot('s82-B-pause-clicked', runDir)

        // The pause click can land after completion (the documented race). If it
        // paused, Resume + Discard Partial + the Paused badge must be a11y-targetable.
        const pd = Date.now() + 15000
        while (Date.now() < pd) {
          if (await B.has({ role: 'button', name: 'Resume' })) { sawResume = true; break }
          if (await B.hasText('On your device')) break
          await sleep(200)
        }
        if (sawResume) {
          assert(await B.hasText('Paused'), 'row badge shows Paused')
          assert(await B.has({ role: 'button', name: 'Discard Partial' }),
            'Discard Partial is also exposed on the paused loose row')
          await B.shot('s82-B-paused', runDir)
          await B.click({ role: 'button', name: 'Resume' }) // resume so the file completes
        }
      }
    })

    await r.ok('the file lands "On your device"', async () => {
      await waitFor(() => existsSync(landed), 120000, 'payload.bin landed on B')
      await B.waitText('On your device', 30000)
      await B.shot('s82-B-downloaded', runDir)
    })

    console.log(`s82: running controls caught: ${sawPause}; paused-row controls caught: ${sawResume}`)
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
