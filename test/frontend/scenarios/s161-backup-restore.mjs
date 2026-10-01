import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { makeReport, waitFor } from '../assert.mjs'

const PASS = 'a long enough passphrase'

// A backup restored on a fresh install: onboarding offers a backup folder, the recovery key opens
// it, the snapshots it holds are listed, and the restored identity opens with its space — never
// onboarding.
export default async function s161({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const backupDir = path.join(runDir, 'backup-target')
  mkdirSync(backupDir, { recursive: true })
  const keyFile = path.join(runDir, 'alice.mirallkey')
  const r = makeReport()
  const flags = { localBackup: true }
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2, flags })
  const B = new Instance({ name: 'NewDevice', bootstrap, slot: 1, total: 2, flags })
  const showBackups = { role: 'button', name: 'Show backups' }
  const restore = { role: 'button', name: 'Restore' }

  try {
    await r.ok('back up the recovery key and the app storage', async () => {
      await A.launch()
      await A.createSpaceOnly('Aurora')
      await A.openAccount()
      await A.click({ role: 'button', name: 'Back up your recovery key' })
      await A.setRaw({ role: 'textfield', name: 'Choose a passphrase' }, PASS)
      await A.setRaw({ role: 'textfield', name: 'Confirm passphrase' }, PASS)
      await A.nativeChoosePath(keyFile, { trigger: () => A.click({ role: 'button', name: 'Save backup file…' }) })
      await A.waitText('Recovery key saved to your chosen location.', 30000)
      await A.gotoSettings('Storage')
      await A.nativeChoosePath(backupDir, { trigger: () => A.click({ role: 'button', name: 'Browse… (backup folder)' }) })
      await A.waitText('Last backup', 60000)
      await A.quit()
    })
    await r.ok('onboarding offers a restore from a backup folder', async () => {
      await B.launch({ onboard: false })
      await B.waitText('Welcome to Mirall', 45000)
      // A re-render first: the link must survive the renderer's first config write.
      await B.type({ role: 'textfield', name: 'Display Name' }, 'x')
      await B.click({ role: 'button', name: 'Restore from a backup folder' })
      await B.waitText('Choose the folder that holds your Mirall backup', 8000)
      await B.shot('s161-dialog', runDir)
    })
    await r.ok('the key opens the folder and lists its backups', async () => {
      await B.nativeChoosePath(backupDir, { trigger: () => B.click({ role: 'button', name: 'Browse… (backup folder)' }) })
      await B.nativeChoosePath(keyFile, { trigger: () => B.click({ role: 'button', name: 'Choose recovery key file…' }) })
      await B.setRaw({ role: 'textfield', name: 'Passphrase' }, 'not the passphrase')
      await waitFor(async () => !(await B.isDisabled(showBackups)), 8000, 'Show backups available')
      await B.click(showBackups)
      await B.waitText("That passphrase didn't match this recovery key.", 60000)
      await B.setRaw({ role: 'textfield', name: 'Passphrase' }, PASS)
      await B.click(showBackups)
      await B.waitText('Choose the backup to restore.', 60000)
      if (!(await B.has({ role: 'radiogroup', name: 'Backups' }))) throw new Error('no backup list')
      await B.shot('s161-snapshots', runDir)
    })
    await r.ok('the restored identity opens with its space', async () => {
      await B.click(restore)
      await B.waitText('Aurora', 120000)
      if (await B.hasText('Welcome to Mirall')) throw new Error('onboarding is showing over a restored identity')
      await B.shot('s161-restored', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
