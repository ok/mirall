import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { makeReport, waitFor } from '../assert.mjs'

// Settings ▸ Network: the Relays section, one slot. Covers the add → auto-probe → replace →
// remove flow with an OPEN relay key, the self-hosting guide link, and the a11y contract every
// control has to meet. The invite (ticket) paths are s137.
const RELAY_KEY = 'yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy'
const OTHER_KEY = 'usdgj55ym13jkwz7nyrn4tf9yog5ocqhgbzpmiapfunqoj398xqo'

// The menu portals into the body and react-aria moves focus into it; give it a frame to
// mount before addressing an item, the way s13 does for the space overflow menu.
const settle = () => new Promise((res) => setTimeout(res, 400))

export default async function s106({ runDir, bootstrap }) {
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
      // Mirall names no relay of its own — the only way in is running one yourself or being
      // invited to one, so this link is the feature's entry point, not a decoration.
      if (!(await Relays.has({ role: 'link', contains: 'How to run your own relay' }))) {
        throw new Error('self-hosting guide link not targetable')
      }
    })

    await r.ok('with no relay configured the mode control is absent, not disabled', async () => {
      if (await Relays.has({ name: 'Use a relay' })) throw new Error('mode control rendered with nothing to apply it to')
      await Relays.waitText('No relay configured', 8000)
    })

    await r.ok('a malformed input names the format, not a generic invalid', async () => {
      await Relays.click({ name: 'Add relay' })
      await Relays.waitText('Add a relay', 8000)
      await Relays.type({ name: 'Relay key or invite' }, 'not-a-relay-key')
      await Relays.click({ name: 'Continue' })
      await Relays.waitText('not a relay key or an invite', 8000)
      await Relays.shot('s106-invalid', runDir)
    })

    await r.ok('a valid key is confirmed as an open relay before it is committed', async () => {
      await Relays.type({ name: 'Relay key or invite' }, RELAY_KEY)
      await Relays.click({ name: 'Continue' })
      await Relays.waitText('Open relay', 8000)
      await Relays.waitText('Anyone with the key can use it', 8000)
      await Relays.shot('s106-confirm', runDir)
    })

    await r.ok('committing adds the slot and opts into using a relay', async () => {
      await Relays.type({ name: 'Name (optional)' }, 'Test relay')
      await Relays.click({ name: 'Add relay' })
      await Relays.waitText('Test relay', 8000)
      // Adding a relay while the mode is 'off' would configure something inert.
      await waitFor(async () => (await Relays.nodeValue({ name: 'Use a relay' })) === '1', 8000, 'relay on')
      await Relays.shot('s106-added', runDir)
    })

    await r.ok('the probe runs on its own at configuration time', async () => {
      // Nobody answers on this key, so the verdict is Unreachable — the point is that it
      // arrives without anyone pressing Test. A mistyped key is caught when it is entered.
      await Relays.waitText('Unreachable', 25000)
      await Relays.shot('s106-auto-probed', runDir)
    })

    await r.ok('the row menu is reachable by name and carries all three acts', async () => {
      if (!(await Relays.has({ name: 'Options for Test relay' }))) {
        throw new Error('row menu not targetable by accessible name')
      }
      await Relays.click({ name: 'Options for Test relay' })
      await settle()
      for (const item of ['Test', 'Replace', 'Remove']) {
        if (!(await Relays.has({ name: item }))) throw new Error(`menu item not targetable: ${item}`)
      }
      await Relays.shot('s106-menu', runDir)
      await Relays.press('Escape')
      await settle()
    })

    await r.ok('the advanced toggle states its cost before it is flipped, not after', async () => {
      // The consequence rides the control's own description, so it is readable while the switch is
      // still off.
      await Relays.waitText('even when a direct one would work', 8000)
      if ((await Relays.nodeValue({ name: 'Route everything through the relay' })) !== '0') {
        throw new Error('route-everything defaults on')
      }
      await Relays.click({ name: 'Route everything through the relay' })
      await waitFor(async () => (await Relays.nodeValue({ name: 'Route everything through the relay' })) === '1', 8000, 'always on')
      await Relays.click({ name: 'Route everything through the relay' })
      await waitFor(async () => (await Relays.nodeValue({ name: 'Route everything through the relay' })) === '0', 8000, 'back to auto')
    })

    // Turning the feature off leaves a configured relay that is not in use. The row dims with the
    // switch and its badge says so, rather than going on claiming a reachability verdict that is
    // no longer being applied — but it stays present and its menu stays live, because that menu is
    // the only way to test, replace or remove the slot.
    await r.ok('switching relaying off marks the slot disabled without stranding it', async () => {
      await Relays.click({ name: 'Use a relay' })
      await Relays.waitText('Disabled', 8000)
      if (await Relays.hasText('Unreachable')) throw new Error('a stale verdict outlived the switch')
      if (!(await Relays.has({ name: 'Options for Test relay' }))) throw new Error('the slot lost its menu')
      await Relays.shot('s106-disabled', runDir)

      await Relays.click({ name: 'Use a relay' })
      await Relays.waitText('Unreachable', 15000)
    })

    // REGRESSION (FIX-4: the master switch mapped on→'auto' unconditionally, so an explicit
    // 'always' was discarded by any off/on round trip — something the three-way control it
    // replaced could not do, and nothing on screen reported.)
    await r.ok('the master switch restores the mode that was on, not just auto', async () => {
      await Relays.click({ name: 'Route everything through the relay' })
      await waitFor(async () => (await Relays.nodeValue({ name: 'Route everything through the relay' })) === '1', 8000, 'always on')

      await Relays.click({ name: 'Use a relay' })
      await Relays.click({ name: 'Use a relay' })
      await waitFor(async () => (await Relays.nodeValue({ name: 'Route everything through the relay' })) === '1', 8000, 'always survived the round trip')

      await Relays.click({ name: 'Route everything through the relay' })
      await waitFor(async () => (await Relays.nodeValue({ name: 'Route everything through the relay' })) === '0', 8000, 'back to auto')
    })

    await r.ok('replacing swaps the slot rather than adding a second one', async () => {
      await Relays.click({ name: 'Options for Test relay' })
      await settle()
      await Relays.click({ name: 'Replace' })
      await Relays.waitText('Replace this relay', 8000)
      await Relays.type({ name: 'Relay key or invite' }, OTHER_KEY)
      await Relays.click({ name: 'Continue' })
      await Relays.waitText('Open relay', 8000)
      await Relays.click({ name: 'Add relay' })
      await waitFor(async () => !(await Relays.hasText('Test relay')), 8000, 'the old slot is gone')
      await Relays.shot('s106-replaced', runDir)
    })

    await r.ok('the relay survives a reopen, then removes cleanly', async () => {
      await Relays.click({ name: 'Back' })
      await Relays.waitText('Manage your experience', 8000)
      await Relays.click({ name: 'Network' })
      await Relays.waitText('usdgj55y', 8000)

      await Relays.click({ name: 'Options for usdgj55ym13jkwz7nyrn4tf9yog5ocqhgbzpmiapfunqoj398xqo' })
      await settle()
      await Relays.click({ name: 'Remove' })
      // An open relay removes without a confirmation: nothing about it is unrecoverable.
      await Relays.waitText('No relay configured', 8000)
      await Relays.shot('s106-removed', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [Relays] }
}
