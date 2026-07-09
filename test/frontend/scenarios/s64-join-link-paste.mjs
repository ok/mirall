import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { makeReport, waitFor } from '../assert.mjs'

// JoinSpaceModal auto-strips a pasted mirall://join App link down to the bare
// invite code, so a user who copied the "App link" format can paste it into the
// Join dialog and have it accepted. Verifies the visible strip: after the field
// is set to a full deep link it shows only the code, and the stripped code is
// usable (Join enabled). A valid v0 hex code wrapped in the link the Invite modal
// would mint (mirall://join/<code>) — no peer required for the strip assertion.
export default async function s64 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1 })

  const CODE = 'a'.repeat(8) + 'b'.repeat(8) + 'c'.repeat(8) + 'd'.repeat(8) +
               'e'.repeat(8) + 'f'.repeat(8) + '0'.repeat(8) + '1'.repeat(8)
  const LINK = `mirall://join/${CODE}`
  const field = { role: 'textfield', name: 'Invite Code' }

  try {
    await r.ok('launch + open Join modal', async () => {
      await A.launch()
      await A.openJoinModal()
    })
    await r.ok('pasting an App link strips it to the bare invite code', async () => {
      await A.setRaw(field, LINK)
      await waitFor(
        async () => (await A.nodeValue(field)) === CODE,
        8000,
        'field strips the mirall://join link to the bare code',
      )
      const v = await A.nodeValue(field)
      if (v.startsWith('mirall://')) throw new Error(`field still holds the link: ${v}`)
      await A.shot('s64-stripped', runDir)
    })
    await r.ok('the stripped code is accepted (Join enabled, no invalid-invite error)', async () => {
      await waitFor(
        async () => !(await A.isDisabled({ role: 'button', name: 'Join Space', last: true })),
        8000,
        'Join enabled once the link is stripped to a code',
      )
      if (await A.hasText('invalid invite')) throw new Error('invalid-invite error shown for a stripped link')
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
