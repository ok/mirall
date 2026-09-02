import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { makeReport, assert } from '../assert.mjs'
import { connectInSpace } from '../helpers.mjs'
import { workDir } from '../paths.mjs'

// The folder screen's acts are reachable from the command palette, scoped to the folder on screen.
// Three properties are worth proving through the UI, because none of them is visible to a unit
// test: the entries exist only while that folder is open, sync is offered as a swinging LABEL
// rather than a dead row, and which entries appear follows the role.
//
// Every assertion is a string strictly LONGER than the query typed to reach it. The palette input's
// own value is part of the window text, so asserting on the query itself would pass against the
// typing rather than against a rendered row.
export default async function s124 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const ownDir = path.join(workDir('own-'), 'Archive')
  mkdirSync(ownDir, { recursive: true })
  writeFileSync(path.join(ownDir, 'readme.txt'), 'so the folder exists at share time')

  const palette = async (I, query) => {
    await I.press('cmd+k')
    await new Promise((res) => setTimeout(res, 600))
    await I.type({ role: 'combobox' }, query)
    await new Promise((res) => setTimeout(res, 400))
  }

  try {
    await r.ok('A and B share a space; A owns "Archive"', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B)
      await A.focus()
      await A.addOwnedFolder(ownDir)
      await A.waitText('Archive', 60000)
      await A.openFolder('Archive')
    })

    await r.ok('the owner\'s folder acts are listed, and the mirror act is not', async () => {
      await palette(A, 'archive')
      assert(await A.hasText('Open folder Archive'), 'Open is offered')
      assert(await A.hasText('Pause syncing Archive'), 'Pause is offered')
      assert(await A.hasText('Edit folder Archive'), 'Edit is offered')
      // Absent rather than greyed: mirroring a folder you own is meaningless, not blocked.
      assert(!(await A.hasText('Mirror Archive to disk')), 'no mirror act on a folder you own')
      assert(!(await A.hasText('Locate folder Archive')), 'no locate act while the source is present')
      await A.shot('s124-A-palette-owner', runDir)
      await A.press('escape')
    })

    // The design's centre of gravity: a folder that is not syncing offers Resume, never a listed
    // dead Pause. One id, one row, a label that swings with the folder's state.
    await r.ok('firing Pause from the palette swings the entry to Resume', async () => {
      await palette(A, 'pause syncing')
      assert(await A.hasText('Pause syncing Archive'), 'the row is there to fire')
      await A.press('return')
      await A.waitText('Paused', 30000)
      await palette(A, 'syncing')
      assert(await A.hasText('Resume syncing Archive'), 'the same entry now offers the way back')
      assert(!(await A.hasText('Pause syncing Archive')), 'and never lists both verbs at once')
      await A.shot('s124-A-palette-resume', runDir)
      await A.press('escape')
    })

    await r.ok('leaving the folder takes its acts out of the palette', async () => {
      await A.back()
      await A.waitText('Drop to Share', 30000)
      await palette(A, 'archive')
      assert(!(await A.hasText('Resume syncing Archive')), 'no folder act survives the screen')
      assert(!(await A.hasText('Open folder Archive')), 'no folder act survives the screen')
      assert(!(await A.hasText('Edit folder Archive')), 'no folder act survives the screen')
      await A.shot('s124-A-palette-out-of-scope', runDir)
      await A.press('escape')
    })

    // REGRESSION: useRegisterCommand rebuilt each command without carrying hiddenInPalette, so the
    // one command flagged to stay out of the list — the palette's own opener — was listed inside it.
    await r.ok('REGRESSION: the palette does not list itself', async () => {
      await palette(A, 'command palette')
      assert(!(await A.hasText('Open command palette')), 'the palette opener stays hidden')
      assert(await A.hasText('No commands match'), 'and nothing else claims that query')
      await A.press('escape')
    })

    await r.ok('a browsed folder offers the mirror act instead, and it works', async () => {
      await B.focus()
      await B.waitText('Archive', 60000)
      await B.openFolder('Archive')
      await palette(B, 'mirror')
      assert(await B.hasText('Mirror Archive to disk'), 'the mirror act is offered')
      assert(!(await B.hasText('Pause syncing Archive')), 'nothing to pause on a folder you only browse')
      assert(!(await B.hasText('Open folder Archive')), 'and no local folder to open')
      await B.shot('s124-B-palette-browse', runDir)
      await B.press('return')
      await B.waitText('Mirror location on your disk', 20000)
      await B.shot('s124-B-mirror-modal', runDir)
      await B.press('escape')
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
