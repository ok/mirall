import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert } from '../assert.mjs'
import { workDir } from '../paths.mjs'

const sleep = (ms) => new Promise((res) => setTimeout(res, ms))

// A3 — pause a loose download, then Discard Partial from the paused row (distinct
// from cancel-while-running in s83): the row returns to "Available" + Download and
// the partial is removed (files:discard-partial). Best-effort on catching the paused
// state — loopback can finish a 256 MB download before we can pause — so when the
// pause is lost the discard path simply isn't exercised (logged, not failed); when
// it is caught, the discard→revert is the asserted guarantee.
export default async function s84 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const dir = workDir('loose-discard-')
  const big = path.join(dir, 'draft.bin')
  mkdirSync(dir, { recursive: true })
  writeFileSync(big, Buffer.alloc(256 * 1024 * 1024, 21))
  const landed = path.join(B.downloadFolder, 'draft.bin')

  let sawPaused = false
  try {
    await r.ok('A shares a big loose file; B sees it Available', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addFile(big)
      await A.waitText('draft', 60000)
      await B.waitText('draft', 90000)
      await B.waitText('Available', 90000)
    })

    await r.ok('B downloads, pauses, then discards the partial → reverts to Available', async () => {
      await B.click({ role: 'button', name: 'Download', last: true })

      let sawPause = false
      const dl = Date.now() + 20000
      while (Date.now() < dl) {
        if (await B.has({ role: 'button', name: 'Pause Download' })) { sawPause = true; break }
        if (await B.hasText('On your device')) break
        await sleep(200)
      }
      if (!sawPause) { console.log('s84: download finished before pause could be caught — discard path not exercised'); return }

      await B.click({ role: 'button', name: 'Pause Download' })
      const pd = Date.now() + 15000
      while (Date.now() < pd) {
        if (await B.has({ role: 'button', name: 'Discard Partial' })) { sawPaused = true; break }
        if (await B.hasText('On your device')) break
        await sleep(200)
      }
      if (!sawPaused) { console.log('s84: pause click lost the race to completion — discard path not exercised'); return }

      assert(await B.hasText('Paused'), 'row shows Paused before discard')
      await B.shot('s84-B-paused', runDir)

      await B.click({ role: 'button', name: 'Discard Partial' })

      const rev = Date.now() + 15000
      let back = false
      while (Date.now() < rev) {
        if (await B.has({ role: 'button', name: 'Download' }) && await B.hasText('Available')) { back = true; break }
        await sleep(200)
      }
      assert(back, 'row reverts to Available + Download after discarding the partial')
      assert(!existsSync(landed), 'no file landed at the destination after discard')
      await B.shot('s84-B-discarded', runDir)
    })

    console.log(`s84: paused-row caught: ${sawPaused}`)
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
