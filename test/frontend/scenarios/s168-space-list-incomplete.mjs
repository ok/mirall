import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'
import { flatten } from '../tree.mjs'

// The space file list says when it is still loading. While a member who is online has not had
// their file list read in full, the space screen shows one note instead of claiming the list is
// whole — and, with no rows yet, instead of the "nothing shared yet" empty state. Once that member
// is away, their read no longer holds the list open and the note goes.
//
// Bob is relaunched with MIRALL_INTERACTIVE_READ_TIMEOUT_MS=1, so every read of Alice's catalog
// stalls while she stays online. He joins on the default budget first: the lever starves every
// interactive read, and the join path reads profiles under it.
//
// Pairs with the space-content-state unit truth table and a VoiceOver spot-check: the note is a
// Callout, read once, in order, above the rows; its icon is aria-hidden.
const NOTE = "Some members' files are still loading, so more may appear."
// Presence lease TTL (presence-leases.js) plus a convergence tick, with room for a slow box.
const AWAY_MS = 90000

export default async function s168({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const dir = workDir('list-incomplete-')
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'agenda.txt')
  writeFileSync(file, 'agenda')

  try {
    await r.ok('A shares a loose file and B sees it, with no note on a whole list', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addFile(file)
      await B.waitText('agenda', 90000)
      assert(!(await B.hasText(NOTE)), 'a list read in full carries no note')
    })

    await r.ok('with B unable to finish reading A, B\'s space says the list is still loading', async () => {
      B.env.MIRALL_INTERACTIVE_READ_TIMEOUT_MS = '1'
      await B.relaunch()
      await B.waitText('Aurora', 60000)
      await B.click({ name: 'Open Aurora' })
      await B.waitText(NOTE, 60000)
      const nodes = flatten(await B.snap()).filter((n) => `${n.name} ${n.value}`.includes('still loading'))
      assert(nodes.length === 1, `the note is one accessible text node (found ${nodes.length})`)
      assert(`${nodes[0].name} ${nodes[0].value}`.includes(NOTE), 'and that node carries the whole sentence')
      assert(!(await B.hasText('Nothing shared yet')), 'an incomplete list is not presented as empty')
      await B.shot('s168-B-incomplete', runDir)
    })

    await r.ok('once A is away, A\'s stalled read no longer holds the list open', async () => {
      await A.quit()
      await waitFor(async () => !(await B.hasText(NOTE)), AWAY_MS, 'the note cleared after A went offline')
      await B.shot('s168-B-owner-away', runDir)
    })
  } catch {} finally {
    delete B.env.MIRALL_INTERACTIVE_READ_TIMEOUT_MS
  }
  return { pass: r.summary(), instances: [A, B] }
}
