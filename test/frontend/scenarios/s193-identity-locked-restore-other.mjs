import { mkdirSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { makeReport, waitFor } from '../assert.mjs'
import { setUpBackup, firstBackupDone, findKek, workerPid } from '../helpers.mjs'

const PASS = 'a long enough passphrase'

// A locked device restores another identity's backup. The key opens none of this device's own data,
// so the backup's snapshots are offered, and restoring one opens that identity in the worker that
// showed the locked screen: no restart, no onboarding, and the restored space is there.
export default async function s193({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })
  const backupDir = path.join(runDir, 's193-backup')
  mkdirSync(backupDir, { recursive: true })
  const showBackups = { role: 'button', name: 'Show backups' }
  const passphrase = { role: 'textfield', name: 'Passphrase' }
  let lockedPid = 0

  try {
    await r.ok('Alice backs up an identity with a space', async () => {
      await A.launch()
      await A.createSpaceOnly('Aurora')
      await A.click({ name: 'Home' })
      await A.click({ role: 'button', name: 'Set up backup' })
      await setUpBackup(A, backupDir, PASS)
      await firstBackupDone(A)
      await A.quit()
    })
    await r.ok('Bob\'s device is locked: a different identity, a key that opens none of it', async () => {
      await B.launch()
      await B.createSpaceOnly('Bobs')
      await B.quit()
      const kek = findKek(B.store)
      if (!kek) throw new Error('kek.enc not found under the instance store')
      writeFileSync(kek, randomBytes(64))
      await B.launch({ onboard: false })
      await B.waitText("Mirall can't open your data", 45000)
      lockedPid = workerPid(B.store)
    })
    await r.ok('Alice\'s backup is listed, because it is not Bob\'s data', async () => {
      await B.click({ role: 'button', name: 'Restore from a backup' })
      await B.nativeChoosePath(backupDir, { trigger: () => B.click({ role: 'button', name: 'Browse… (backup folder)' }) })
      await B.waitText('Found your backup', 15000)
      await B.setRaw(passphrase, PASS)
      await waitFor(async () => !(await B.isDisabled(showBackups)), 8000, 'Show backups available')
      await B.click(showBackups)
      await B.waitText('Choose the backup to restore.', 60000)
      await B.shot('s193-snapshots', runDir)
    })
    await r.ok('restoring it opens that identity in the same worker', async () => {
      await B.click({ role: 'button', name: 'Restore' })
      await B.waitText('Aurora', 120000)
      if (await B.hasText('Welcome to Mirall')) throw new Error('onboarding is showing over a restored identity')
      if (await B.hasText("Mirall can't open your data")) throw new Error('the locked screen is still up')
      if (workerPid(B.store) !== lockedPid) throw new Error('the worker was replaced: the restore did not open in place')
      await B.shot('s193-restored', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
