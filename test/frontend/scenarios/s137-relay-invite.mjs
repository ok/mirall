import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { makeReport, waitFor } from '../assert.mjs'

// Settings ▸ Network: the invite-ticket paths s106 does not reach — the two error messages a
// key cannot produce, the private-relay confirm step, and the copy that names what membership
// actually costs. The vector is the frozen one from the relay↔client contract §2.5.
const TICKET = 'mirall://relay/ygqac38xcbqmffk19weyomkrzhny5qbt5oag7iqzbwscj4b88h7758musqus5hrut9afmj5qjorsaigcrtpumig5gg4af6i4uzxjjm1qhz55ppy'

export default async function s137({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const Relays = new Instance({ name: 'Invite', bootstrap, slot: 0, total: 1 })

  try {
    await r.ok('the add modal opens on the paste field', async () => {
      await Relays.launch()
      await Relays.gotoSettings('Network')
      await Relays.waitText('Relays', 8000)
      await Relays.click({ name: 'Add relay' })
      await Relays.waitText('Add a relay', 8000)
    })

    // A paste that lost its final character still decodes to the same 69 bytes and passes the
    // checksum, so only the length gate catches it — and it is the commonest clipboard failure
    // there is. Through the UI: the message has to say "incomplete", not "not a relay key".
    await r.ok('a truncated invite says it is incomplete', async () => {
      await Relays.type({ name: 'Relay key or invite' }, TICKET.slice(0, -1))
      await Relays.click({ name: 'Continue' })
      await Relays.waitText('looks incomplete', 8000)
      await Relays.shot('s137-truncated', runDir)
    })

    await r.ok('a valid invite shows the relay it decodes to and names the trade', async () => {
      await Relays.type({ name: 'Relay key or invite' }, TICKET)
      await Relays.click({ name: 'Continue' })
      await Relays.waitText('Private relay', 8000)
      await Relays.waitText('usdgj55y', 8000)
      await Relays.waitText('who you connect to', 8000)
      // The consequence is stated BEFORE the commit, not discovered after it.
      await Relays.waitText('takes effect after Mirall reconnects', 8000)
      await Relays.shot('s137-confirm', runDir)
    })

    await r.ok('the invite itself is never rendered back', async () => {
      // It carries the member seed. One ticket per person, re-issued by the operator — the app
      // must not make it copyable off this screen.
      if (await Relays.hasText(TICKET.slice(15, 45))) throw new Error('the ticket payload is on screen')
    })

    await r.ok('committing configures the private relay and turns relaying on', async () => {
      await Relays.type({ name: 'Name (optional)' }, 'Family relay' )
      await Relays.click({ name: 'Add relay' })
      await Relays.waitText('Family relay', 15000)
      await Relays.waitText('Private relay', 8000)
      await waitFor(async () => (await Relays.nodeValue({ name: 'Use a relay' })) === '1', 8000, 'relay on')
      await Relays.shot('s137-configured', runDir)
    })

    // REGRESSION: committing a pinned identity must not take the worker down (that reloads the window
    // onto the home screen); it waits for a reconnect the user asks for, and the section says so.
    await r.ok('the pending reconnect is explained in place, not performed behind the user', async () => {
      await Relays.waitText('It takes effect when Mirall reconnects', 8000)
      if (!(await Relays.has({ name: 'Reconnect now' }))) throw new Error('no way to apply the new identity')
      if (!(await Relays.has({ name: 'Options for Family relay' }))) throw new Error('navigated away from Network')
      await Relays.shot('s137-pending', runDir)
    })

    // REGRESSION (FIX-3: a probe dialled with the identity the worker booted with — not the one just
    // stored — always failed, wrote Unreachable to config, and the `!relay.lastTest` guard then
    // suppressed the probe forever.)
    await r.ok('no probe is burned while the identity is still pending', async () => {
      await Relays.waitText('Not tested', 10000)
      if (await Relays.hasText('Unreachable')) throw new Error('probed with the pre-restart identity')
    })

    // The whole deferred-restart path, end to end: the worker exits, the respawn policy brings it
    // back on the new boot frame, the window reloads, and only then is the verdict worth having.
    await r.ok('reconnecting applies the identity and the probe then runs', async () => {
      await Relays.click({ name: 'Reconnect now' })
      await Relays.waitText('Shared Spaces', 30000)
      await Relays.gotoSettings('Network')
      await Relays.waitText('Family relay', 15000)
      if (await Relays.has({ name: 'Reconnect now' })) throw new Error('still pending after the restart')
      await Relays.waitText('Unreachable', 30000)
      await Relays.shot('s137-reconnected', runDir)
    })

    // REGRESSION (FIX-7: Replace erased the member seed with no confirmation at all, while
    // Remove — the identical irreversible act — was gated behind an alertdialog. Both destroy the
    // only copy of the invite.)
    await r.ok('replacing a private relay asks first, exactly as removing does', async () => {
      await Relays.click({ name: 'Options for Family relay' })
      await new Promise((res) => setTimeout(res, 400))
      await Relays.click({ name: 'Replace' })
      await Relays.waitText('Replace Family relay?', 8000)
      await Relays.waitText('will be erased', 8000)
      await Relays.shot('s137-replace-confirm', runDir)

      await Relays.click({ name: 'Cancel' })
      if (await Relays.hasText('Add a relay')) throw new Error('cancelling still opened the add modal')
      await Relays.waitText('Family relay', 8000)
    })

    await r.ok('removing a private relay asks first, and says what it costs', async () => {
      await Relays.click({ name: 'Options for Family relay' })
      await new Promise((res) => setTimeout(res, 400))
      await Relays.click({ name: 'Remove' })
      await Relays.waitText('Remove Family relay?', 8000)
      await Relays.waitText('new invite from whoever runs it', 8000)
      await Relays.shot('s137-remove-confirm', runDir)

      await Relays.click({ name: 'Cancel' })
      await Relays.waitText('Family relay', 8000)
    })
  } catch {}
  return { pass: r.summary(), instances: [Relays] }
}
