import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport } from '../assert.mjs'

// Account profile edit: A changes its display name and saves; the new name
// broadcasts and B sees it on A's member card. (Avatar upload goes through a
// native picker + crop and isn't asserted here; the input-file size guard +
// worker-side clamp are covered by the unit/integration layers.)
export default async function s14 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  try {
    await r.ok('launch + connect', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await B.waitText('Alice', 60000)
    })
    await r.ok('A renames itself in Account and saves', async () => {
      await A.openAccount()
      await A.type({ role: 'textfield' }, 'Alice Cooper')
      await A.click({ role: 'button', name: 'Save Changes' })
      await A.back()
      await A.shot('s14-A-renamed', runDir)
    })
    await r.ok('the new name propagates to the peer member list', async () => {
      await B.waitText('Alice Cooper', 60000)
      await B.shot('s14-B-sees-name', runDir)
    })
    // MIR-12: maxLength={80} accepts an exactly-80-char name (a smaller cap would make
    // type()'s read-back fail) and the live counter reflects the cap.
    await r.ok('display name field accepts the max length with a live counter', async () => {
      await A.openAccount()
      await A.type({ role: 'textfield' }, 'q'.repeat(80))
      await A.waitText('80/80', 8000)
      await A.shot('s14-A-name-counter', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
