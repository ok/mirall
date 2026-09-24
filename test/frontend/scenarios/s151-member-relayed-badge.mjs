import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, waitFor } from '../assert.mjs'
import { findNode } from '../tree.mjs'
import { startLocalRelay } from '../../helpers/local-relay.js'

// The member roster names the path: a member whose connection runs through a relay reads
// "Online · via relay" under their name, as ONE accessible text node, and reads "Offline" once the
// peer is gone. Alice runs with relayMode 'always' against a local blind relay.
export default async function s151({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const relay = await startLocalRelay(bootstrap)
  const relayCfg = {
    relayMode: 'always',
    relay: { publicKey: relay.key, kind: 'open', label: 'Test relay', enabled: true, lastTest: null },
  }
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2, flags: relayCfg })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })
  let label = null

  try {
    await r.ok('A and B share Aurora; A expands the members list', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.focus()
      await A.waitText('Members', 60000)
      await A.click({ role: 'button', name: 'Show all' })
      await waitFor(async () => A.hasText('Bob'), 30000, 'Bob is in the expanded list')
    })

    await r.ok("Bob's presence line is one accessible string, relayed or direct", async () => {
      // Loopback may punch through before the relay carries a byte: either label is a correct
      // outcome, but whichever it is must be ONE static-text node under the name — so the wait is
      // on the node itself. `hasText` would match "Online" inside "Online · via relay" and pass on
      // a line split across nodes.
      await waitFor(async () => {
        const tree = await A.snap()
        label = ['Online · via relay', 'Online'].find((name) => findNode(tree, { role: 'statictext', name })) ?? null
        return label !== null
      }, 30000, 'the presence line to be one static text node')
      await A.shot(label === 'Online · via relay' ? 's151-relayed' : 's151-direct-on-loopback', runDir)
    })

    // Bob has no relay of his own, so a connection Alice's relay carries is one his settings cannot
    // end: the Relay section names her instead of offering a reconnect.
    await r.ok("Bob's relay settings name the member whose relay carries him", async () => {
      await B.focus()
      await B.gotoSettings('Network')
      await B.waitText('A relay helps two devices connect', 8000)
      if (label !== 'Online · via relay') {
        await B.shot('s151-settings-direct-on-loopback', runDir)
        return
      }
      await B.waitText('is connected to you through their own relay', 30000)
      if (!(await B.hasText('Alice'))) throw new Error('the note does not name Alice')
      await B.shot('s151-settings-adopted-note', runDir)
    })

    await r.ok('Bob quits; the line returns to Offline', async () => {
      await B.quit()
      await A.focus()
      await waitFor(async () => A.hasText('Offline'), 60000, 'Bob reads offline after quitting')
      await A.shot('s151-offline', runDir)
    })
  } catch {} finally {
    await relay.close()
  }
  return { pass: r.summary(), instances: [A, B] }
}
