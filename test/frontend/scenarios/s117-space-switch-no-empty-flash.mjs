import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { makeReport, assert } from '../assert.mjs'
import { allText } from '../tree.mjs'
import { workDir } from '../paths.mjs'

// Moving between spaces must never paint an "empty" screen over one that has content. Both
// panes involved are fed by reads that settle on their own schedule — the space list by
// spaces:list, a space's pane by files:list AND share:list — and each empty state is gated on
// its sources having settled, so the strings watched for below are unreachable rather than
// merely unlikely. That makes the sampling one-sided: a snapshot that lands "too late" can
// only miss a violation, never invent one, so this cannot flake red. Aurora holds a folder
// share and no loose files on purpose — that is the shape where the file read settles first
// (from its listing cache) while the share read is still draining.
export default async function s117 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1 })

  const ownDir = path.join(workDir('switch-'), 'Photos')
  mkdirSync(ownDir, { recursive: true })
  writeFileSync(path.join(ownDir, 'a.txt'), 'AAA')

  // Snapshot in a tight loop from the moment of a navigation until `goal` renders, failing the
  // instant `forbidden` is seen. One snapshot answers both questions, so nothing can slip
  // between two reads of the same frame.
  const watch = async (goal, forbidden, timeout = 30000) => {
    const deadline = Date.now() + timeout
    let samples = 0
    while (Date.now() < deadline) {
      const text = allText(await A.snap())
      samples++
      assert(!text.includes(forbidden), `"${forbidden}" flashed while ${goal} was loading (sample ${samples})`)
      if (text.includes(goal)) return samples
    }
    throw new Error(`timed out waiting for "${goal}" (${timeout}ms, ${samples} samples)`)
  }

  try {
    await r.ok('a space with a folder share and a second, empty space exist', async () => {
      await A.launch()
      await A.createSpaceOnly('Aurora')
      await A.addOwnedFolder(ownDir)
      await A.waitText('Photos', 20000)
      await A.back()
      await A.createSpaceOnly('Borealis')
      await A.back()
      await A.waitText('Open Aurora', 20000)
    })

    await r.ok('opening a space with content never flashes the empty-share hero', async () => {
      await A.click({ name: 'Open Aurora' })
      const samples = await watch('Photos', 'Nothing shared yet')
      console.log(`s117: Aurora opened clean over ${samples} sample(s)`)
      await A.shot('s117-aurora-open', runDir)
    })

    await r.ok('returning to the list never flashes the no-spaces hero', async () => {
      await A.back()
      const samples = await watch('Open Aurora', 'No spaces yet')
      console.log(`s117: the space list rendered clean over ${samples} sample(s)`)
    })

    await r.ok('re-entering the same space stays clean on the warm path', async () => {
      // The revisit is the case the caches exist for: the pane's rows are already known, so it
      // renders them straight away rather than starting over from an empty screen.
      await A.click({ name: 'Open Aurora' })
      const samples = await watch('Photos', 'Nothing shared yet')
      console.log(`s117: Aurora re-opened clean over ${samples} sample(s)`)
      await A.back()
      await A.waitText('Open Borealis', 20000)
    })

    await r.ok('a genuinely empty space still shows the hero and its docs card', async () => {
      // The gate suppresses the unsettled window, not the state itself.
      await A.click({ name: 'Open Borealis' })
      await A.waitText('Nothing shared yet', 30000)
      await A.waitText('What happens when you share', 20000)
      assert(await A.has({ role: 'link', contains: 'Share a whole folder' }), 'docs card links still render')
      await A.shot('s117-borealis-empty', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
