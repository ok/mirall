import { mkdirSync, writeFileSync, renameSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { allText, flatten } from '../tree.mjs'
import { workDir } from '../paths.mjs'

// REGRESSION (A.4: a paused folder whose source went missing showed both states at once — the
// "Locate folder…" strip stacked above a "Resume" strip — and the header menu still offered Resume
// syncing, which the worker refuses with SOURCE_FOLDER_MISSING. The pause and the last pass's
// outcome are two facts; the screen shows the one the user can act on, and the pause resurfaces
// once the source is back.)
//
// The restore step waits past the 60s mount-point probe interval: the folder coming back is not the
// user pressing Resume, so nothing else re-derives the status.
export default async function s142({ runDir }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', slot: 0, total: 1 })

  const parent = workDir('own-')
  const ownDir = path.join(parent, 'Ledger')
  const movedDir = path.join(parent, 'Ledger-moved')
  mkdirSync(ownDir, { recursive: true })
  writeFileSync(path.join(ownDir, 'q1.txt'), 'numbers')

  const menuLabels = async () => {
    const nodes = flatten(await A.snap())
    return nodes.filter((n) => n.role === 'menuitem').map((n) => n.label || '')
  }

  try {
    await r.ok('A shares "Ledger" and pauses it from the folder menu', async () => {
      await A.launch()
      await A.createSpaceOnly('Aurora')
      await A.addOwnedFolder(ownDir)
      await A.waitText('Ledger', 60000)
      await A.openFolder('Ledger')
      await A.waitText('q1.txt', 20000)

      await A.click({ name: 'More', last: true })
      await A.click({ name: 'Pause syncing' })
      await A.waitText('Adding files is paused', 60000)
      await A.shot('s142-paused', runDir)
    })

    await r.ok('the source goes missing, and the screen shows ONE state', async () => {
      renameSync(ownDir, movedDir)
      await waitFor(async () => /source folder moved or unavailable/i.test(allText(await A.snap())),
        90000, 'the missing-source strip appears')

      const text = allText(await A.snap())
      assert(!/adding files is paused/i.test(text),
        'and the paused strip is gone — the missing source is the state the user can act on')
      assert(await A.hasText('Missing'), 'the tile pill agrees with the strip')

      const buttons = flatten(await A.snap()).filter((n) => n.role === 'button')
      assert(buttons.some((b) => /locate folder/i.test(b.label || '')), 'the strip carries Locate folder…')
      assert(!buttons.some((b) => /^resume$/i.test(b.label || '')), 'and no Resume the worker would refuse')
      await A.shot('s142-missing-not-paused', runDir)
    })

    await r.ok('the header menu offers Pause, never a Resume that cannot run', async () => {
      await A.click({ name: 'More', last: true })
      const labels = await menuLabels()
      assert(labels.some((l) => /pause syncing/i.test(l)),
        'the folder is not presented as paused while it is missing')
      assert(!labels.some((l) => /resume syncing/i.test(l)),
        'so the menu cannot raise SOURCE_FOLDER_MISSING')
      await A.shot('s142-menu-offers-pause', runDir)
      await A.press('escape')
    })

    // Split rather than compound: the two halves fail for different reasons — the first if the
    // probe's return edge never reached the UI, the second if it reached it as the wrong state —
    // and one timeout covering both names neither. The budget is three probe intervals.
    await r.ok('the returning source clears the missing state', async () => {
      // The strip above can appear from the listing's own live mountRootAvailable, before the 60s
      // mount-point probe has recorded anything. The probe reports a TRANSITION, so a folder that
      // leaves and returns inside one interval leaves it with nothing to report and the screen keeps
      // the stale listing. Wait out a full interval here so the departure is recorded first.
      await new Promise((done) => setTimeout(done, 70000))
      renameSync(movedDir, ownDir)
      await waitFor(async () => !/source folder moved or unavailable/i.test(allText(await A.snap())),
        190000, 'the missing-source strip goes when the folder comes back')
      await A.shot('s142-source-returned', runDir)
    })

    await r.ok('and the pause the user set is what it returns to', async () => {
      await waitFor(async () => /adding files is paused/i.test(allText(await A.snap())),
        30000, 'a folder coming back is not a Resume')
      assert(!(await A.hasText('Missing')), 'and the tile pill follows it back')
      const buttons = flatten(await A.snap()).filter((n) => n.role === 'button')
      assert(buttons.some((b) => /^resume$/i.test(b.label || '')), 'the way back is offered again')
      await A.shot('s142-paused-again', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
