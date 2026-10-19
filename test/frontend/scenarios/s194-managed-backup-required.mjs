import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { makeReport, assert } from '../assert.mjs'
import { startManagedConsole } from '../managed-console.mjs'

const PASS = 'a long enough passphrase'

// An organization that sets the backup folder and requires a backup: the Spaces card cannot be put
// off, setup shows the organization's folder instead of a picker, and Settings → Backup locks the
// switch and the folder while the passphrase stays the person's.
export default async function s194({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const share = path.join(runDir, 's194-share')
  mkdirSync(share, { recursive: true })
  const r = makeReport()
  const fixture = await startManagedConsole()
  fixture.serve({ 'backup.folder.macos': `${share}/{user}/{host}-{install}`, 'backup.folder.linux': `${share}/{user}/{host}-{install}`, 'backup.required': true })
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1, env: fixture.env })
  const automatic = { role: 'switch', name: 'Back up automatically' }
  try {
    await r.ok('connected, the Spaces card asks for a backup with no Not now', async () => {
      await A.launch()
      await A.createSpaceOnly('Aurora')
      await A.openDeepLink(fixture.link)
      await A.waitText('Connect Mirall to Acme Test GmbH?', 20000)
      await A.click({ role: 'button', name: 'Connect' })
      await A.waitText('Connected to Acme Test GmbH', 15000)
      await A.click({ name: 'Home' })
      await A.waitText('requires a backup of this computer', 15000)
      assert(!(await A.has({ role: 'button', name: 'Not now' })), 'the offer cannot be put off')
      await A.shot('s194-required-card', runDir)
    })

    await r.ok('setup shows the organization\'s folder and sets up with the person\'s passphrase', async () => {
      await A.click({ role: 'button', name: 'Set up backup' })
      await A.waitText('Step 1 of 2', 8000)
      await A.waitText('Set by Acme Test GmbH', 8000)
      assert(!(await A.has({ role: 'button', name: 'Browse… (backup folder)' })), 'no folder picker')
      await A.shot('s194-setup-folder', runDir)
      await A.click({ role: 'button', name: 'Next' })
      await A.waitText('Step 2 of 2', 8000)
      await A.setRaw({ role: 'textfield', name: 'Choose a passphrase' }, PASS)
      await A.setRaw({ role: 'textfield', name: 'Confirm passphrase' }, PASS)
      await A.click({ role: 'button', name: 'Turn on backup' })
      await A.waitText('Backup is on', 120000)
    })

    await r.ok('Settings → Backup locks the switch and the folder, the passphrase stays the person\'s', async () => {
      await A.gotoSettings('Backup')
      await A.waitText('Backup Folder', 15000)
      assert(await A.isDisabled(automatic), 'the switch reads unavailable while required')
      assert(await A.isDisabled({ role: 'button', name: 'Change (backup folder)' }), 'Change reads unavailable')
      assert(!(await A.isDisabled({ role: 'button', name: 'Check passphrase' })), 'the passphrase is the person\'s')
      await A.shot('s194-settings-locked', runDir)
    })
  } catch {} finally {
    await fixture.close()
  }
  return { pass: r.summary(), instances: [A] }
}
