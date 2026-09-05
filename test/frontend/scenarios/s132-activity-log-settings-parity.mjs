import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { allText } from '../tree.mjs'
import { workDir } from '../paths.mjs'

// The Account screen and the Activity Log settings screen report the same two facts — how many
// events are recorded, and whether recording is on. They used to read them twice: Account through
// the query store, the settings screen through its own hand-rolled effect. Two reads of one fact
// can disagree, which is the whole reason the store exists; they now share its two entries.
//
// Asserted as a string equality rather than a pair of regexes, because "they agree" is the claim.
const eventsRecorded = (text) => (/(\d+) events? recorded/i.exec(text) ?? [])[1] ?? null

export default async function s132 ({ runDir }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', slot: 0, total: 1 })

  const ownDir = path.join(workDir('own-'), 'Reports')
  mkdirSync(ownDir, { recursive: true })
  writeFileSync(path.join(ownDir, 'q1.txt'), 'numbers')

  let fromAccount = null

  try {
    await r.ok('A does enough to record some activity', async () => {
      await A.launch()
      await A.createSpaceOnly('Aurora')
      await A.addOwnedFolder(ownDir)
      await A.waitText('Reports', 60000)
    })

    await r.ok('the Account screen reports a count', async () => {
      await A.openAccount()
      await waitFor(async () => eventsRecorded(allText(await A.snap())) !== null, 20000,
        'the activity row carries the recorded count')
      fromAccount = eventsRecorded(allText(await A.snap()))
      assert(Number(fromAccount) > 0, 'and it is a real count, not a placeholder zero')
      await A.shot('s132-account', runDir)
    })

    await r.ok('the Activity Log settings screen reports the same count', async () => {
      await A.back()
      await A.gotoSettings('Activity Log')
      await A.waitText('Choose what Mirall records', 20000)
      await waitFor(async () => eventsRecorded(allText(await A.snap())) !== null, 20000,
        'the settings screen carries the recorded count too')
      const fromSettings = eventsRecorded(allText(await A.snap()))
      assert(fromSettings === fromAccount,
        `both screens report one number for one log (account ${fromAccount}, settings ${fromSettings})`)
      await A.shot('s132-settings', runDir)
    })

    await r.ok('turning recording off on one screen is what the other screen reports', async () => {
      await A.click({ role: 'switch', name: 'Record activity' })
      await waitFor(async () => await A.isChecked({ role: 'switch', name: 'Record activity' }) === false, 20000,
        'the toggle settles off on the screen that owns it')
      await A.back()
      await A.openAccount()
      await waitFor(async () => /recording is off/i.test(allText(await A.snap())), 20000,
        'the Account row reads the pushed config rather than a copy it fetched separately')
      await A.shot('s132-recording-off', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
