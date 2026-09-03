import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert } from '../assert.mjs'
import { flatten } from '../tree.mjs'

// The joiner's membership.granted row used to render a '?' avatar over "was granted access" with
// nobody named: onGrant passed msg.profileKey, a field the grant frame has never carried, so the
// actor key was null and the name lookup had nothing to key on. The copy was wrong too — the actor
// is the GRANTER, so "{{actor}} was granted access" said the opposite of what happened.
export default async function s126 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  try {
    await r.ok('Alice approves Bob into the space', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
    })

    await r.ok('Bob\'s log names Alice as the one who gave him access', async () => {
      await B.focus()
      await B.openActivityLog()
      await B.waitText('gave you access', 20000)
      assert(await B.hasText('Alice gave you access to Aurora'),
        'the sentence names the granter and the space — it used to read "was granted access" with a hole where the actor goes')
      await B.shot('s126-granted-row', runDir)
    })

    // The '?' avatar is NOT assertable here: the bubble is aria-hidden by design, because the
    // sentence already names the actor. It was only ever a correct rendering of bad data —
    // actorInitials({key: null, name: null}) === '?', pinned in audit-row.test.js — so the fix is
    // upstream, and the assertion above is what proves it. The shot is the visual record.
    await r.ok('the sentence is one accessible node, not three fragments', async () => {
      const nodes = flatten(await B.snap()).map((n) => n.name || n.value || '')
      assert(nodes.some((n) => n.includes('gave you access to')),
        'the whole sentence reaches the AX tree as one string, so VoiceOver does not read it in pieces')
      assert(!nodes.some((n) => n.trim() === 'Alice'),
        'and the emphasised fragments are hidden from it rather than duplicated')
    })

    await r.ok('it is a Members row', async () => {
      await B.click({ role: 'checkbox', name: 'Members' })
      await B.waitText('gave you access', 10000)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
