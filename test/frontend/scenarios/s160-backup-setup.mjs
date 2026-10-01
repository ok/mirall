import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { makeReport, waitFor } from '../assert.mjs'

// The backup on Settings → Storage: offered with a note that restoring needs the recovery key,
// turned on by choosing a folder, run at once on request, and turned off again.
export default async function s160({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const backupDir = path.join(runDir, 'backup-target')
  mkdirSync(backupDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1, flags: { localBackup: true } })
  const runNow = { role: 'button', name: 'Back up now' }

  try {
    await r.ok('Storage offers a backup folder', async () => {
      await A.launch()
      await A.createSpaceOnly('Aurora')
      await A.gotoSettings('Storage')
      await A.waitText('Backup', 8000)
      await A.waitText('Restoring a backup needs your recovery key.', 8000)
      await A.shot('s160-not-set-up', runDir)
    })
    await r.ok('choosing a folder backs up into it', async () => {
      await A.nativeChoosePath(backupDir, { trigger: () => A.click({ role: 'button', name: 'Browse… (backup folder)' }) })
      await A.waitText(backupDir, 8000)
      await A.waitText('Last backup', 60000)
      if (!(await A.has(runNow))) throw new Error('no Back up now button')
      if (!(await A.has({ role: 'button', name: 'Change (backup folder)' }))) throw new Error('the folder button is not named for the backup')
      await A.shot('s160-set-up', runDir)
    })
    await r.ok('Back up now runs again', async () => {
      await waitFor(async () => !(await A.isDisabled(runNow)), 30000, 'Back up now available')
      await A.click(runNow)
      await A.waitText('Last backup', 60000)
    })
    await r.ok('Turn off returns to the folder choice', async () => {
      await A.click({ role: 'button', name: 'Turn off' })
      await A.waitText('Restoring a backup needs your recovery key.', 8000)
      if (await A.has(runNow)) throw new Error('Back up now still offered after turning off')
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
