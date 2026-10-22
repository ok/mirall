import { mkdirSync, renameSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { makeReport, waitFor } from '../assert.mjs'
import { setUpBackup } from '../helpers.mjs'

const PASS = 'a long enough passphrase'
const OFFLINE_TITLE = 'Your backup folder isn’t connected'

// A backup folder that is gone is said once, in the verdict, with the fix beside the folder; the
// screen holds still while the backup retries, and clears once a run reaches the folder again.
export default async function s199({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const backupDir = path.join(runDir, 's199-backup')
  const awayDir = path.join(runDir, 's199-backup-away')
  mkdirSync(backupDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1 })
  const runNow = { role: 'button', name: 'Back up now' }

  try {
    await r.ok('a backup is set up', async () => {
      await A.launch()
      await A.createSpaceOnly('Aurora')
      await A.gotoSettings('Backup')
      await A.click({ role: 'button', name: 'Set up backup' })
      await setUpBackup(A, backupDir, PASS)
      await waitFor(async () => !(await A.isDisabled(runNow)), 120000, 'the first run finished')
    })
    await r.ok('a folder that is gone is named in the verdict, with a warning beside the folder', async () => {
      renameSync(backupDir, awayDir)
      await A.click(runNow)
      await A.waitText(OFFLINE_TITLE, 30000)
      await A.waitText('Not connected', 8000)
      if (await A.hasText('then try again')) throw new Error('the separate error line is still shown')
      await A.shot('s199-offline', runDir)
    })
    await r.ok('the screen holds still while the backup is gone', async () => {
      for (let i = 0; i < 6; i++) {
        if (!(await A.hasText(OFFLINE_TITLE))) throw new Error(`the verdict changed after ${i * 500} ms`)
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    })
    await r.ok('a run that reaches the folder again clears it', async () => {
      renameSync(awayDir, backupDir)
      await A.click(runNow)
      await waitFor(async () => !(await A.hasText(OFFLINE_TITLE)), 60000, 'the verdict no longer names the folder')
      if (await A.hasText('Not connected')) throw new Error('the folder warning is still shown')
      await A.shot('s199-back', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
