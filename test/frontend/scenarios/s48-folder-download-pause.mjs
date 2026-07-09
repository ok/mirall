import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

const sleep = (ms) => new Promise((res) => setTimeout(res, ms))

// A folder-view single-file download exposes Pause/Cancel while running and
// Resume/Discard while paused. We assert those a11y-targetable controls (role +
// name + Paused state) WHEN we catch the transfer mid-flight — but local
// loopback can finish a 256 MB download inside the AX click latency, so the
// paused-row controls are checked best-effort and a lost race is not a failure
// (matches s42). The file landing at "On your device" is the hard guarantee;
// the pause→resume round-trip's correctness is owned by the flow test.
export default async function s48 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const ownDir = path.join(workDir('own-'), 'Bulky')
  mkdirSync(ownDir, { recursive: true })
  // 256 MB widens the window so we usually DO catch the running/paused controls;
  // when loopback still wins, the best-effort blocks below absorb it.
  writeFileSync(path.join(ownDir, 'big.bin'), Buffer.alloc(256 * 1024 * 1024, 7))

  let sawPauseButton = false
  let sawResumeButton = false

  try {
    await r.ok('A shares "Bulky" eager; B opens the folder and sees big.bin', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addOwnedFolder(ownDir)
      await B.waitText('Bulky', 60000)
      await B.openFolder('Bulky')
      await B.waitText('big.bin', 20000)
      assert(await B.hasText('Available'), 'big.bin shown as Available before download')
    })

    await r.ok('B downloads; pause/resume controls are exercised when the race allows', async () => {
      await B.click({ role: 'button', name: 'Download' })

      // Best-effort: catch the running row's controls. Bail when Pause appears OR
      // the transfer already finished (fast loopback). Not finding Pause is not a
      // failure — only a lost race.
      const dlDeadline = Date.now() + 15000
      while (Date.now() < dlDeadline) {
        if (await B.has({ role: 'button', name: 'Pause Download' })) { sawPauseButton = true; break }
        if (await B.hasText('On your device')) break
        await sleep(200)
      }

      if (sawPauseButton) {
        // We caught it running — the running-row a11y IS asserted here.
        assert(await B.has({ role: 'button', name: 'Cancel' }), 'Cancel is reachable on the running row')
        await B.click({ role: 'button', name: 'Pause Download' })
        await B.shot('s48-B-pause-clicked', runDir)

        // Best-effort: the pause click can land after the download already
        // completed (the documented race). If it paused, Resume + Discard +
        // the Paused badge must be present and a11y-targetable.
        const pDeadline = Date.now() + 15000
        while (Date.now() < pDeadline) {
          if (await B.has({ role: 'button', name: 'Resume' })) { sawResumeButton = true; break }
          if (await B.hasText('On your device')) break // pause click lost the race
          await sleep(200)
        }

        if (sawResumeButton) {
          assert(await B.hasText('Paused'), 'row badge shows Paused')
          assert(await B.has({ role: 'button', name: 'Discard Partial' }),
            'Discard Partial is also exposed on the paused row')
          await B.shot('s48-B-paused', runDir)
          await B.click({ role: 'button', name: 'Resume' }) // resume so the file completes
        }
      }
    })

    await r.ok('the file lands at "On your device"', async () => {
      const landed = path.join(B.downloadFolder, 'big.bin')
      await waitFor(() => existsSync(landed), 90000, 'big.bin landed')
      await B.waitText('On your device', 30000)
      await B.shot('s48-B-downloaded', runDir)
    })

    console.log(`s48: running controls caught: ${sawPauseButton}; paused-row controls caught: ${sawResumeButton}`)
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
