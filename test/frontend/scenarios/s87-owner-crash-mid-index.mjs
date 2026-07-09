import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert } from '../assert.mjs'
import { workDir } from '../paths.mjs'

const sleep = (ms) => new Promise((res) => setTimeout(res, ms))

// B4 [characterization] — hard-kill the owner mid-index (a crash / force-quit) then relaunch
// on the SAME store, exercising the loose-publish restart path (GH#356). Asserted invariant
// (holds across the fix): the app reboots cleanly into its space (no wedge) and is NOT stuck
// forever on "Adding" (the zombie). The interrupted file's actual end-state is captured as
// evidence — observed: a hard crash before the advertise flushes leaves the entry simply
// ABSENT on reboot ("Nothing shared yet"); the stuck-"Adding" zombie lives on the graceful-quit
// path where the advertise persisted but the hash did not. Needs the relaunch harness (kill()
// wipes the store). See plan-loose-publish-restart-recovery.md.
export default async function s87 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const dir = workDir('crash-index-')
  const big = path.join(dir, 'archive.bin')
  mkdirSync(dir, { recursive: true })
  writeFileSync(big, Buffer.alloc(512 * 1024 * 1024, 3))

  let caughtAdding = false
  let observed = '(unknown)'
  try {
    await r.ok('A adds a big file and is hard-killed while still "Adding"', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addFile(big)
      const dl = Date.now() + 20000
      while (Date.now() < dl) {
        if (await A.hasText('Adding')) { caughtAdding = true; break }
        if (await A.hasText('Shared by you')) break
        await sleep(150)
      }
      console.log(`s87: caught "Adding" before crash: ${caughtAdding}`)
      await A.shot('s87-A-before-crash', runDir)
      await A.relaunch({ hard: true }) // crash mid-index, boot fresh on the same store
    })

    await r.ok('A reboots cleanly into the space and is not a stuck "Adding" zombie', async () => {
      await A.waitText('Aurora', 45000)       // returning user → space list (no Welcome)
      await A.click({ name: 'Open Aurora' })  // spaceCard.openSpace = "Open {{name}}"
      await A.waitText('Invite', 20000)       // space-view chrome loaded → the app did not wedge

      // Let a boot re-hash settle: wait up to 60s for the file to resolve to absent or 'mine';
      // only if it lingers as a row after that is it a candidate zombie.
      const dl = Date.now() + 60000
      while (Date.now() < dl) {
        if (!(await A.hasText('archive'))) { observed = 'absent'; break }
        if (await A.hasText('Shared by you')) { observed = 'recovered:mine'; break }
        await sleep(1000)
      }
      if (observed === '(unknown)') observed = (await A.hasText('Adding')) ? 'zombie:adding' : 'present:other'
      await A.shot('s87-A-after-relaunch', runDir)

      // The one hard invariant across the fix: NOT stuck perpetually on "Adding".
      assert(observed !== 'zombie:adding', 'owner is not stuck on a perpetual "Adding" zombie after the crash')
    })

    console.log(`s87: caught Adding: ${caughtAdding}; post-relaunch end-state = ${observed}`)
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
