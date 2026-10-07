import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { makeReport, waitFor } from '../assert.mjs'
import { setUpBackup } from '../helpers.mjs'

const PASS = 'a long enough passphrase'

// A backup restored on a fresh install with nothing but the folder and the passphrase: the snapshots
// are listed, and the restored identity opens with its space.
export default async function s161({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const backupDir = path.join(runDir, 's161-backup')
  mkdirSync(backupDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'NewDevice', bootstrap, slot: 1, total: 2 })
  const showBackups = { role: 'button', name: 'Show backups' }
  const passphrase = { role: 'textfield', name: 'Passphrase' }

  try {
    await r.ok('set up a backup', async () => {
      await A.launch()
      await A.createSpaceOnly('Aurora')
      await A.click({ name: 'Home' })
      await A.click({ role: 'button', name: 'Set up backup' })
      await setUpBackup(A, backupDir, PASS)
      await A.quit()
    })
    await r.ok('onboarding offers one restore: from a backup folder', async () => {
      await B.launch({ onboard: false })
      await B.waitText('Welcome to Mirall', 45000)
      // A re-render first: the link must survive the renderer's first config write.
      await B.type({ role: 'textfield', name: 'Display Name' }, 'x')
      await B.click({ role: 'button', name: 'Already used Mirall? Restore from a backup' })
      await B.waitText('Choose the folder that holds your Mirall backup.', 8000)
      await B.shot('s161-choice', runDir)
    })
    await r.ok('the folder and its passphrase open the backup', async () => {
      await B.nativeChoosePath(backupDir, { trigger: () => B.click({ role: 'button', name: 'Browse… (backup folder)' }) })
      await B.waitText('Found your backup', 15000)
      await B.setRaw(passphrase, 'not the passphrase at all')
      await waitFor(async () => !(await B.isDisabled(showBackups)), 8000, 'Show backups available')
      await B.click(showBackups)
      await B.waitText("That passphrase doesn't open this backup.", 60000)
      await B.setRaw(passphrase, PASS)
      await B.click(showBackups)
      await B.waitText('Choose the backup to restore.', 60000)
      if (!(await B.has({ role: 'radiogroup', name: 'Backups' }))) throw new Error('no backup list')
      await B.waitText('Latest', 8000)
      await B.shot('s161-snapshots', runDir)
    })
    await r.ok('the restored identity opens with its space', async () => {
      await B.click({ role: 'button', name: 'Restore' })
      await B.waitText('Aurora', 120000)
      if (await B.hasText('Welcome to Mirall')) throw new Error('onboarding is showing over a restored identity')
      await B.shot('s161-restored', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
