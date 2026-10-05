import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, waitFor } from '../assert.mjs'

const PASS = 'a long enough passphrase'

// A restore while the people it is shared with are away: the app opens read-only with a banner, and
// changes wait. When a co-member comes online and confirms the profile, the banner goes, a toast says
// so, and changes are possible again — without leaving the app.
export default async function s164({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const backupDir = path.join(runDir, 's164-backup')
  mkdirSync(backupDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 3 })
  const C = new Instance({ name: 'Carol', bootstrap, slot: 1, total: 3 })
  const B = new Instance({ name: 'NewDevice', bootstrap, slot: 2, total: 3 })
  const create = { role: 'button', name: 'Create Space' }

  try {
    await r.ok('Alice shares a space with Carol and backs up', async () => {
      await A.launch()
      await C.launch()
      await connectInSpace(A, C)
      await A.click({ name: 'Home' })
      await A.click({ role: 'button', name: 'Set up backup' })
      await A.nativeChoosePath(backupDir, { trigger: () => A.click({ role: 'button', name: 'Browse… (backup folder)' }) })
      await A.click({ role: 'button', name: 'Use it anyway' })
      await A.setRaw({ role: 'textfield', name: 'Choose a passphrase' }, PASS)
      await A.setRaw({ role: 'textfield', name: 'Confirm passphrase' }, PASS)
      await A.click({ role: 'button', name: 'Turn on backup' })
      await A.waitText("You're protected", 120000)
      await A.click({ role: 'button', name: 'Done' })
      await A.quit()
      await C.quit()
    })
    await r.ok('the restored app opens read-only while Carol is away', async () => {
      await B.launch({ onboard: false })
      await B.waitText('Welcome to Mirall', 45000)
      await B.click({ role: 'button', name: 'Already used Mirall? Restore your account' })
      await B.click({ role: 'button', name: 'Next' })
      await B.nativeChoosePath(backupDir, { trigger: () => B.click({ role: 'button', name: 'Browse… (backup folder)' }) })
      await B.waitText('Found your backup and recovery key', 15000)
      await B.setRaw({ role: 'textfield', name: 'Passphrase' }, PASS)
      await B.click({ role: 'button', name: 'Show backups' })
      await B.waitText('Choose the backup to restore.', 60000)
      await B.click({ role: 'button', name: 'Restore' })
      await B.waitText('Your data is restored', 120000)
      await B.waitText('Aurora', 15000)
      await waitFor(async () => B.isDisabled(create), 8000, 'Create Space held')
      await B.shot('s164-read-only', runDir)
    })
    await r.ok('Details shows the restore and what it waits for', async () => {
      await B.click({ role: 'button', name: 'Details' })
      await B.waitText('Waiting for someone you share a space with to come online…', 15000)
      await B.shot('s164-details', runDir)
    })
    await r.ok('Carol comes online and the restore is confirmed', async () => {
      await C.launch({ onboard: false })
      await B.waitText('Your profile is confirmed', 180000)
      await B.click({ name: 'Home' })
      await waitFor(async () => !(await B.has({ role: 'button', name: 'Details' })), 30000, 'banner gone')
      await waitFor(async () => !(await B.isDisabled(create)), 30000, 'Create Space available')
      await B.shot('s164-released', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, C, B] }
}
