import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { makeReport } from '../assert.mjs'

// The invite modal yields ONE link (the mirall://join/ app link) — no Code/App-link format selector
// — and reveals it only after "Create invite link" is clicked.
export default async function s19 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1 })

  try {
    await r.ok('launch + create space + open invite', async () => {
      await A.launch()
      await A.createSpaceOnly('Aurora')
      await A.openInviteModal()
    })
    await r.ok('no format selector and no link before Create', async () => {
      if (await A.has({ name: 'App link' }) || await A.has({ name: 'Code' })) throw new Error('format selector should be gone')
      if (await A.has({ role: 'button', name: 'Copy' })) throw new Error('link must not exist before Create')
      await A.shot('s19-configure', runDir)
    })
    await r.ok('Create reveals a single mirall://join/ app link', async () => {
      await A.click({ role: 'button', name: 'Create invite link' })
      await A.waitText('Invite link ready')
      const link = await A.copyFrom({ role: 'button', name: 'Copy' })
      if (!link.startsWith('mirall://join/')) throw new Error(`expected app link, got: ${link}`)
      await A.shot('s19-applink', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
