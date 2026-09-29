import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { makeReport, waitFor } from '../assert.mjs'
import { allText } from '../tree.mjs'

// Activity Log: every saved change to the relay setup is one "You …" row, and nothing else is. The
// add's automatic probe and the mode it switches on write no row of their own, and no row shows a
// full relay key. Each sentence is one sr-only node, so waiting on the whole sentence is also the
// check that a screen reader hears it as one.
const RELAY_KEY = 'yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy'
const OTHER_KEY = 'usdgj55ym13jkwz7nyrn4tf9yog5ocqhgbzpmiapfunqoj398xqo'
const OTHER_MASKED = 'usdgj55y…398xqo'

const settle = () => new Promise((res) => setTimeout(res, 400))

async function toggle(A, name, value) {
  await A.click({ name })
  await waitFor(async () => (await A.nodeValue({ name })) === value, 8000, `${name} ${value}`)
}

export default async function s154({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Relays', bootstrap, slot: 0, total: 1 })

  try {
    await r.ok('add a relay and let the automatic probe finish', async () => {
      await A.launch()
      await A.gotoSettings('Network')
      await A.waitText('A relay helps two devices connect', 8000)
      await A.click({ name: 'Add relay' })
      await A.waitText('Add a relay', 8000)
      await A.type({ name: 'Relay key or invite' }, RELAY_KEY)
      await A.click({ name: 'Continue' })
      await A.waitText('Open relay', 8000)
      await A.type({ name: 'Name (optional)' }, 'Test relay')
      await A.click({ name: 'Add relay' })
      await A.waitText('Test relay', 8000)
      // The probe's verdict is saved like any other change; it must not become a row.
      await A.waitText('Unreachable', 25000)
    })

    await r.ok('switch when the relay is used, and turn it off and on', async () => {
      await toggle(A, 'Prefer the relay for every connection', '1')
      await toggle(A, 'Prefer the relay for every connection', '0')
      await A.click({ name: 'Use a relay' })
      await A.waitText('Disabled', 8000)
      await A.click({ name: 'Use a relay' })
      await A.waitText('Unreachable', 15000)
    })

    await r.ok('replace the relay with an unlabelled one, then remove it', async () => {
      await A.click({ name: 'Options for Test relay' })
      await settle()
      await A.click({ name: 'Replace' })
      await A.waitText('Replace this relay', 8000)
      await A.type({ name: 'Relay key or invite' }, OTHER_KEY)
      await A.click({ name: 'Continue' })
      await A.waitText('Open relay', 8000)
      await A.click({ name: 'Add relay' })
      await waitFor(async () => !(await A.hasText('Test relay')), 8000, 'the old slot is gone')
      await A.click({ name: `Options for ${OTHER_KEY}` })
      await settle()
      await A.click({ name: 'Remove' })
      await A.waitText('No relay configured', 8000)
    })

    await r.ok('each change is one sentence in the Activity Log', async () => {
      await A.openActivityLog()
      for (const sentence of [
        'You added the relay Test relay',
        'You changed when the relay Test relay is used',
        'You turned off the relay Test relay',
        'You turned on the relay Test relay',
        `You replaced the relay with ${OTHER_MASKED}`,
        `You removed the relay ${OTHER_MASKED}`,
      ]) {
        await A.waitText(sentence, 8000)
      }
      await A.shot('s154-log', runDir)
    })

    // The probe verdict and the mode the add switched on wrote no rows: two mode switches and one
    // switch-on for the one add. Counted against the add, because the AX tree carries each sentence
    // more than once, and not against the list total, which unrelated connectivity rows can grow.
    await r.ok('the probe and the add\'s own switch-on wrote no rows', async () => {
      const text = allText(await A.snap()).toLowerCase()
      const count = (needle) => text.split(needle.toLowerCase()).length - 1
      const added = count('You added the relay')
      if (added < 1) throw new Error('the added row is missing')
      if (count('You changed when the relay') !== 2 * added) throw new Error('mode-change rows are not two per add row')
      if (count('You turned on the relay') !== added) throw new Error('turned-on rows are not one per add row')
    })

    await r.ok('no row shows a full relay key', async () => {
      if (await A.hasText(RELAY_KEY)) throw new Error('the added relay key is shown in full')
      if (await A.hasText(OTHER_KEY)) throw new Error('the replacing relay key is shown in full')
    })

    await r.ok('the added row says what kind of relay it is and when it is used', async () => {
      await A.waitText('Only when a direct connection fails', 8000)
      await A.waitText('Open relay', 8000)
    })

    await r.ok('the Network filter lists the relay rows', async () => {
      await A.click({ role: 'checkbox', name: 'Network' })
      await waitFor(async () => (await A.nodeValue({ role: 'checkbox', name: 'Network' })) === '1', 8000, 'Network filter on')
      await A.waitText(`You removed the relay ${OTHER_MASKED}`, 8000)
      await A.shot('s154-network', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
