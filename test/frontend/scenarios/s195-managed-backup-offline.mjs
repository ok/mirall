import { mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { makeReport, assert } from '../assert.mjs'
import { startManagedConsole } from '../managed-console.mjs'

const PASS = 'a long enough passphrase'

// An organization's share that is not mounted reads as unreachable, in the organization's words,
// and nothing is created in its place.
export default async function s195({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const share = path.join(runDir, 's195-share-not-mounted')
  const r = makeReport()
  const fixture = await startManagedConsole()
  fixture.serve({ 'backup.folder.macos': `${share}/{user}/{install}`, 'backup.folder.linux': `${share}/{user}/{install}` })
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1, env: fixture.env })
  try {
    await r.ok('Turn on backup says the organization\'s share is not reachable', async () => {
      await A.launch()
      await A.openDeepLink(fixture.link)
      await A.waitText('Connect Mirall to Acme Test GmbH?', 20000)
      await A.click({ role: 'button', name: 'Connect' })
      await A.waitText('Connected to Acme Test GmbH', 15000)
      await A.gotoSettings('Backup')
      await A.click({ role: 'button', name: 'Set up backup' })
      await A.waitText('Step 1 of 2', 8000)
      await A.click({ role: 'button', name: 'Next' })
      await A.setRaw({ role: 'textfield', name: 'Choose a passphrase' }, PASS)
      await A.setRaw({ role: 'textfield', name: 'Confirm passphrase' }, PASS)
      await A.click({ role: 'button', name: 'Turn on backup' })
      await A.waitText('backup share isn’t reachable', 30000)
      await A.shot('s195-offline', runDir)
      assert(!existsSync(share), 'the share was not created')
    })
  } catch {} finally {
    await fixture.close()
  }
  return { pass: r.summary(), instances: [A] }
}
