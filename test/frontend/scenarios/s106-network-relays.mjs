import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { makeReport, waitFor } from '../assert.mjs'

// Settings ▸ Network: the Relays section, which ships behind the off-by-default `relay`
// feature flag. Covers both sides of the gate — absent on a default build, and the full
// add → test → toggle → remove flow with the flag on — plus the a11y contract every
// control has to meet (targetable by accessible name, switch state readable).
const RELAY_KEY = 'yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy'

export default async function s106 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  // Default flags: no `relay` key, exactly as shipped.
  const Off = new Instance({ name: 'FlagOff', bootstrap, slot: 0, total: 2 })
  const On = new Instance({ name: 'FlagOn', bootstrap, slot: 1, total: 2, flags: { relay: true } })

  try {
    await r.ok('flag off: the screen is exactly what bandwidth shipped', async () => {
      await Off.launch()
      await Off.gotoSettings('Network')
      await Off.waitText('Transfer limits', 8000)
      if (await Off.hasText('Relays')) throw new Error('Relays section rendered on a flag-off build')
      if (await Off.has({ name: 'Add relay' })) throw new Error('Add relay reachable on a flag-off build')
      await Off.shot('s106-flag-off', runDir)
    })

    await r.ok('flag on: the Relays section appends below Transfer limits', async () => {
      await On.launch()
      await On.gotoSettings('Network')
      await On.waitText('Transfer limits', 8000)
      await On.waitText('Relays', 8000)
      await On.shot('s106-flag-on', runDir)
    })

    await r.ok('with no relay configured the mode control is absent, not disabled', async () => {
      if (await On.has({ name: 'When needed' })) throw new Error('mode control rendered with nothing to apply it to')
      await On.waitText('No relays configured', 8000)
    })

    await r.ok('a malformed key is rejected in the modal, not persisted', async () => {
      await On.click({ name: 'Add relay' })
      await On.waitText('Add a relay', 8000)
      await On.type({ name: 'Relay key' }, 'not-a-relay-key')
      await On.click({ name: 'Add relay' })
      await On.waitText('does not look like a relay key', 8000)
      await On.shot('s106-invalid', runDir)
    })

    await r.ok('a valid key adds a row and opts into auto mode', async () => {
      await On.type({ name: 'Relay key' }, RELAY_KEY)
      await On.type({ name: 'Name (optional)' }, 'Test relay')
      await On.click({ name: 'Add relay' })
      await On.waitText('Test relay', 8000)
      // Adding the first relay while the mode is 'off' would configure something inert.
      await waitFor(async () => (await On.nodeValue({ name: 'When needed' })) === '1', 8000, 'auto selected')
      await On.shot('s106-added', runDir)
    })

    await r.ok('every row control is targetable by accessible name', async () => {
      for (const name of ['Test Test relay', 'Use Test relay', 'Remove Test relay']) {
        if (!(await On.has({ name }))) throw new Error(`control not targetable by name: ${name}`)
      }
    })

    await r.ok('the enable switch exposes its state', async () => {
      await waitFor(async () => (await On.nodeValue({ name: 'Use Test relay' })) === '1', 8000, 'switch on')
      await On.click({ name: 'Use Test relay' })
      await waitFor(async () => (await On.nodeValue({ name: 'Use Test relay' })) === '0', 8000, 'switch off')
      await On.click({ name: 'Use Test relay' })
      await waitFor(async () => (await On.nodeValue({ name: 'Use Test relay' })) === '1', 8000, 'switch back on')
    })

    await r.ok('probing a key nobody serves reports Unreachable', async () => {
      await On.click({ name: 'Test Test relay' })
      await On.waitText('Unreachable', 20000)
      await On.shot('s106-unreachable', runDir)
    })

    await r.ok('always mode surfaces its warning', async () => {
      await On.click({ name: 'Always' })
      await On.waitText('even when a direct one would work', 8000)
    })

    await r.ok('the relay survives a reopen, then removes cleanly', async () => {
      await On.click({ name: 'Back' })
      await On.waitText('Manage your experience', 8000)
      await On.click({ name: 'Network' })
      await On.waitText('Test relay', 8000)

      await On.click({ name: 'Remove Test relay' })
      await waitFor(async () => !(await On.hasText('Test relay')), 8000, 'row gone')
      await On.waitText('No relays configured', 8000)
      await On.shot('s106-removed', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [Off, On] }
}
