import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { makeReport, waitFor } from '../assert.mjs'

// The invite create-flow: configure (auto-approve toggle off by default + three expiry presets, no
// link yet) → Create → the link + setting badges, with Change returning to configure preserving the
// choices. Exercises the new InviteModal end to end through the AX tree.
export default async function s76 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1 })
  const toggle = { name: 'Auto-approve' }

  try {
    await r.ok('configure step: toggle off by default, presets present, no link yet', async () => {
      await A.launch()
      await A.createSpaceOnly('Aurora')
      await A.openInviteModal()
      await waitFor(async () => A.has(toggle), 10000, 'Auto-approve toggle present')
      if (await A.nodeValue(toggle) !== '0') throw new Error('Auto-approve must default to off')
      // Expiry presets are aria-pressed segmented pills — target by name only (role:button doesn't match them).
      for (const name of ['2 hours', '2 days', '2 weeks']) {
        await waitFor(async () => A.has({ name }), 8000, `expiry preset ${name} present`)
      }
      if (await A.has({ role: 'button', name: 'Copy' })) throw new Error('no link before Create')
      await A.shot('s76-configure', runDir)
    })

    await r.ok('Create reveals the link and the setting badges', async () => {
      await A.click(toggle)
      await waitFor(async () => (await A.nodeValue(toggle)) === '1', 10000, 'toggle turns on')
      await A.click({ name: '2 weeks' })
      await A.click({ role: 'button', name: 'Create invite link' })
      await A.waitText('Invite link ready', 10000)
      const link = await A.copyFrom({ role: 'button', name: 'Copy' })
      if (!link.startsWith('mirall://join/')) throw new Error(`expected app link, got: ${link}`)
      if (!(await A.hasText('Auto-approve'))) throw new Error('Auto-approve badge missing')
      if (!(await A.hasText('Expires'))) throw new Error('Expires badge missing')
      await A.shot('s76-created', runDir)
    })

    await r.ok('Change returns to configure with the choices preserved', async () => {
      await A.click({ role: 'button', name: 'Change' })
      await waitFor(async () => A.has(toggle), 8000, 'back on configure')
      if (await A.nodeValue(toggle) !== '1') throw new Error('auto-approve choice not preserved across Change')
    })
  } catch {}

  return { pass: r.summary(), instances: [A] }
}
