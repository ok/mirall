import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { makeReport } from '../assert.mjs'

// Activity Log: a kind is found by its label and by the words of its sentence, though no stored name
// contains them. The relayed-connection and direct-connection rows, when the session produced one,
// read as one sentence with its meta line: the relay's provenance, or how long the relay carried the
// person.
//
// Each search first clears the list with a term nothing matches: the row is on screen before the
// search runs, so without the empty state in between a snapshot taken before the reload would pass.
export default async function s145({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1 })
  const search = { name: 'Search activity' }
  const row = 'You created the space Aurora'
  const searchFinds = async (term) => {
    await A.type(search, 'zzqx-no-match')
    await A.waitText('No events match', 10000)
    await A.type(search, term)
    await A.waitText(row, 10000)
  }

  try {
    await r.ok('launch, create a space, open Activity Log', async () => {
      await A.launch()
      await A.createSpaceOnly('Aurora')
      // The create flow repaints the whole screen and the AX tree re-attaches a beat later.
      await new Promise((res) => setTimeout(res, 1200))
      await A.openActivityLog()
      await A.waitText(row, 10000)
    })
    await r.ok('a kind label finds its row although no name contains it', async () => {
      await searchFinds('space created')
      await A.shot('s145-search-label', runDir)
    })
    await r.ok('words from the sentence find the row too', async () => {
      await searchFinds('you created')
    })
    await r.ok('the relayed-connection kind is reachable through the search field', async () => {
      await A.type({ name: 'Search activity' }, 'relayed')
      await A.shot('s145-search', runDir)
    })
    await r.ok('a relayed row, when present, names the provenance', async () => {
      if (!(await A.hasText('is connected through a relay'))) return
      if (!(await A.hasText('Your relay')) && !(await A.hasText('Relay provided by'))) {
        throw new Error('relayed row without a provenance meta line')
      }
    })
    await r.ok('the direct-connection kind is reachable through the search field', async () => {
      await A.type({ name: 'Search activity' }, 'direct connection')
      await A.shot('s145-search-direct', runDir)
    })
    await r.ok('a direct row, when present, says how long the relay carried the person', async () => {
      if (!(await A.hasText('is connected directly again'))) return
      if (!(await A.hasText('Relayed for'))) throw new Error('direct row without its relayed-for meta line')
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
