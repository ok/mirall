import { mkdirSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { Instance } from '../instance.mjs'
import { createSpaceWithInvite, joinPending } from '../helpers.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { flatten } from '../tree.mjs'
import { encodeInvite, decodeInvite } from '../../../src/shared/contract/invite-envelope.js'

// A joiner shows the inviter an invite names as not yet verified while it waits, and once let in
// the invite's claim stops mattering: the real inviter is a plain member, and a name a forged invite
// added is gone from the roster. The forged code is Alice's real one re-encoded with another owner.
const CAPTION = 'Invited by Mallory · not verified yet'

const oneNodeCarries = (tree, text) =>
  flatten(tree).some((n) => n.role === 'statictext' && [n.name, n.value, n.description].includes(text))

export default async function s153({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  try {
    await r.ok('B joins through a forged invite and the waiting view names Mallory as not verified', async () => {
      await A.launch()
      await B.launch()
      const code = await createSpaceWithInvite(A, { name: 'Aurora' })
      const forged = encodeInvite({ ...decodeInvite(code), owner: randomBytes(32).toString('hex'), ownerName: 'Mallory' })
      await joinPending(B, forged)
      await B.waitText(CAPTION, 15000)
      await waitFor(async () => oneNodeCarries(await B.snap(), CAPTION), 10000, 'the caption to be one static text node')
      await B.shot('s153-waiting-unverified', runDir)
    })

    await r.ok('Alice approves Bob; the roster holds Alice and no longer names Mallory', async () => {
      await A.focus()
      await A.waitText('wants to join', 30000)
      await A.click({ role: 'button', name: 'Approve Bob' })
      await B.focus()
      await B.waitText('Drop to Share', 60000)
      await B.waitText('Members', 30000)
      await B.click({ role: 'button', name: 'Show all' })
      await B.waitText('Alice', 30000)
      await waitFor(async () => !(await B.hasText('Mallory')), 60000, 'Mallory to leave the roster')
      assert(!(await B.hasText('Unverified')), 'no member in the joined space is labelled unverified')
      await B.shot('s153-joined-roster', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
