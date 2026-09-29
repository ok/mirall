import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { makeReport } from '../assert.mjs'

// Activity Log: the relayed-connection and direct-connection kinds are searchable by their labels,
// and a row for either, when the session produced one, reads as one sentence with its meta line: the
// relay's provenance, or how long the relay carried the person.
export default async function s145({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1 })

  try {
    await r.ok('launch + open Activity Log', async () => {
      await A.launch()
      await A.openActivityLog()
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
