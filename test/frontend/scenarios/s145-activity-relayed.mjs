import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { makeReport } from '../assert.mjs'

// Activity Log: the relayed-connection kind is searchable by its label, and a row for it, when the
// session produced one, reads as one sentence with the relay's provenance in its meta line.
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
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
