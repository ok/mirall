import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { allText, flatten } from '../tree.mjs'
import { workDir } from '../paths.mjs'

// #145 gave the owner a notice for the files an index still has queued, with no way to act on it.
// It now carries Pause, and a paused folder says so and offers Resume — one verb, because a folder
// is either running or the user paused it. Pause records a durable intent that survives a restart
// and clears only on Resume, which is what the restart step here proves.
//
// Eight 256 MB files, dropped in AFTER the mount, so the index outlasts a menu-free click by a wide
// margin — a smaller batch hashes before the click lands and the paused path never runs. The
// "Adding" precondition is asserted explicitly so a too-fast scan fails there rather than later as
// a confusing missing button.
export default async function s121 ({ runDir }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', slot: 0, total: 1 })

  const ownDir = path.join(workDir('own-'), 'Archive')
  mkdirSync(ownDir, { recursive: true })
  writeFileSync(path.join(ownDir, 'readme.txt'), 'so the folder exists at share time')

  try {
    await r.ok('A shares "Archive" and drops a batch in that keeps the index busy', async () => {
      await A.launch()
      await A.createSpaceOnly('Aurora')
      await A.addOwnedFolder(ownDir)
      await A.waitText('Archive', 60000)
      await A.openFolder('Archive')
      for (let i = 0; i < 8; i++) {
        writeFileSync(path.join(ownDir, `vol-0${i}.bin`), Buffer.alloc(256 * 1024 * 1024, 11 + i))
      }
      await A.waitText('Adding', 90000)
      assert(!(await A.hasText('Adding files is paused')), 'precondition: the index is running, not paused')
      await A.shot('s121-A-indexing', runDir)
    })

    await r.ok('the notice offers Pause, and the folder says so once paused', async () => {
      // Addressable by role+name IS the accessibility proof: a control the AX tree cannot name is
      // an a11y gap in the control, not a gap in the test.
      await A.click({ role: 'button', name: 'Pause' })
      await waitFor(async () => {
        const text = allText(await A.snap())
        return /adding files is paused/i.test(text) && !/adding \d+ files? to this folder/i.test(text)
      }, 60000, 'the indexing notice is replaced by the paused notice')
      assert(await A.hasText('Resume'), 'and the paused notice offers the way back')
      await A.shot('s121-A-paused', runDir)
    })

    await r.ok('the pause survives a restart — it is durable state, not renderer state', async () => {
      await A.quit()
      await A.launch({ onboard: false })
      // A relaunch lands on the space list, not where the app was left — enter the space first.
      await A.waitText('Aurora', 60000)
      await A.click({ name: 'Open Aurora' })
      await A.openFolder('Archive')
      await A.waitText('Adding files is paused', 90000)
      await A.shot('s121-A-paused-after-restart', runDir)
    })

    await r.ok('Resume picks the index back up', async () => {
      await A.click({ role: 'button', name: 'Resume' })
      // NOT waitText('Adding'): the paused banner reads "Adding files is paused", so that wait is
      // satisfied by the pre-resume DOM and the assertion below would race it.
      await waitFor(async () => {
        const text = allText(await A.snap())
        return /adding \d+ files? to this folder/i.test(text) && !/adding files is paused/i.test(text)
      }, 90000, 'the queue notice replaces the paused one')
      await A.shot('s121-A-resumed', runDir)
    })

    await r.ok('pausing again survives, and there is no second verb to reach for', async () => {
      // Straight back to paused rather than waiting out a multi-GB drain: the drain is s120's job,
      // and a five-minute wait here would be a five-minute wait on a machine, not a test.
      await A.click({ role: 'button', name: 'Pause' })
      await A.waitText('Adding files is paused', 60000)
      const buttons = flatten(await A.snap()).filter((n) => n.role === 'button')
      assert(!buttons.some((b) => /^stop$/i.test(b.label)), 'no Stop control exists in either role')
      await A.shot('s121-A-paused-again', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
