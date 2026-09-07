import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { makeReport, waitFor } from '../assert.mjs'

// Settings ▸ Network: the Relays section. Covers the full add → auto-probe → disable → remove
// flow, the self-hosting guide link, and the a11y contract every control has to meet — each row
// carries one status pill and one overflow menu, both reachable by accessible name.
const RELAY_KEY = 'yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy'

// The menu portals into the body and react-aria moves focus into it; give it a frame to
// mount before addressing an item, the way s13 does for the space overflow menu.
const settle = () => new Promise((res) => setTimeout(res, 400))

export default async function s106 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const Relays = new Instance({ name: 'Relays', bootstrap, slot: 0, total: 1 })

  try {
    await r.ok('the Relays section renders below Transfer limits', async () => {
      await Relays.launch()
      await Relays.gotoSettings('Network')
      await Relays.waitText('Transfer limits', 8000)
      await Relays.waitText('Relays', 8000)
      await Relays.shot('s106-section', runDir)
    })

    await r.ok('the self-host guide is reachable by accessible name', async () => {
      // Mirall names no relay of its own — the only way in is running one yourself, so this
      // link is the feature's entry point, not a decoration.
      if (!(await Relays.has({ role: 'link', contains: 'How to run your own relay' }))) {
        throw new Error('self-hosting guide link not targetable')
      }
    })

    await r.ok('with no relay configured the mode control is absent, not disabled', async () => {
      if (await Relays.has({ name: 'When needed' })) throw new Error('mode control rendered with nothing to apply it to')
      await Relays.waitText('No relays configured', 8000)
    })

    await r.ok('a malformed key is rejected in the modal, not persisted', async () => {
      await Relays.click({ name: 'Add relay' })
      await Relays.waitText('Add a relay', 8000)
      await Relays.type({ name: 'Relay key' }, 'not-a-relay-key')
      await Relays.click({ name: 'Add relay' })
      await Relays.waitText('does not look like a relay key', 8000)
      await Relays.shot('s106-invalid', runDir)
    })

    await r.ok('a valid key adds a row and opts into auto mode', async () => {
      await Relays.type({ name: 'Relay key' }, RELAY_KEY)
      await Relays.type({ name: 'Name (optional)' }, 'Test relay')
      await Relays.click({ name: 'Add relay' })
      await Relays.waitText('Test relay', 8000)
      // Adding the first relay while the mode is 'off' would configure something inert.
      await waitFor(async () => (await Relays.nodeValue({ name: 'When needed' })) === '1', 8000, 'auto selected')
      await Relays.shot('s106-added', runDir)
    })

    await r.ok('the probe runs on its own at configuration time', async () => {
      // Nobody answers on this key, so the verdict is Unreachable — the point is that it
      // arrives without anyone pressing Test. A mistyped key is caught when it is entered.
      await Relays.waitText('Unreachable', 25000)
      await Relays.shot('s106-auto-probed', runDir)
    })

    await r.ok('the both-peers note appears once a relay is configured', async () => {
      // One-sided config works but recovers slowly, and nothing else in the UI says so.
      await Relays.waitText('Add the same relay on both devices', 8000)
    })

    await r.ok('the row menu is reachable by name and carries all three acts', async () => {
      if (!(await Relays.has({ name: 'Options for Test relay' }))) {
        throw new Error('row menu not targetable by accessible name')
      }
      await Relays.click({ name: 'Options for Test relay' })
      await settle()
      for (const item of ['Test', 'Disable', 'Remove']) {
        if (!(await Relays.has({ name: item }))) throw new Error(`menu item not targetable: ${item}`)
      }
      await Relays.shot('s106-menu', runDir)
      await Relays.press('Escape')
      await settle()
    })

    await r.ok('disabling from the menu is reflected in the status pill', async () => {
      await Relays.click({ name: 'Options for Test relay' })
      await settle()
      await Relays.click({ name: 'Disable' })
      await Relays.waitText('Disabled', 8000)
      await Relays.shot('s106-disabled', runDir)

      // The menu now offers the opposite verb, and the pill returns to the probe verdict.
      await Relays.click({ name: 'Options for Test relay' })
      await settle()
      await Relays.click({ name: 'Enable' })
      await Relays.waitText('Unreachable', 8000)
    })

    await r.ok('always mode surfaces its warning', async () => {
      await Relays.click({ name: 'Always' })
      await Relays.waitText('even when a direct one would work', 8000)
    })

    await r.ok('the relay survives a reopen, then removes cleanly', async () => {
      await Relays.click({ name: 'Back' })
      await Relays.waitText('Manage your experience', 8000)
      await Relays.click({ name: 'Network' })
      await Relays.waitText('Test relay', 8000)

      await Relays.click({ name: 'Options for Test relay' })
      await settle()
      await Relays.click({ name: 'Remove' })
      await waitFor(async () => !(await Relays.hasText('Test relay')), 8000, 'row gone')
      await Relays.waitText('No relays configured', 8000)
      await Relays.shot('s106-removed', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [Relays] }
}
