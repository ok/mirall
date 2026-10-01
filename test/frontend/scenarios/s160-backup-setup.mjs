import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { makeReport, waitFor } from '../assert.mjs'

const PASS = 'a long enough passphrase'

// Backup & recovery from Settings: set up in one dialog (folder, passphrase, result), then the status
// shows each safeguard, the passphrase check confirms the key, and turning it off asks first.
export default async function s160({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const backupDir = path.join(runDir, 's160-backup')
  mkdirSync(backupDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1, flags: { localBackup: true } })
  const turnOn = { role: 'button', name: 'Turn on backup' }

  try {
    await r.ok('Settings offers Backup & recovery', async () => {
      await A.launch()
      await A.createSpaceOnly('Aurora')
      await A.gotoSettings('Backup & recovery')
      await A.waitText('Get everything back if this computer breaks or is replaced.', 8000)
      await A.shot('s160-not-set-up', runDir)
    })
    await r.ok('setup takes a folder and a passphrase, and checks the key', async () => {
      await A.click({ role: 'button', name: 'Set up backup' })
      await A.waitText('Step 1 of 3', 8000)
      await A.nativeChoosePath(backupDir, { trigger: () => A.click({ role: 'button', name: 'Browse… (backup folder)' }) })
      // The run folder is on this computer's disk, so the dialog warns and asks to confirm.
      await A.waitText('Same disk as this computer', 8000)
      await A.click({ role: 'button', name: 'Use it anyway' })
      await A.waitText('Step 2 of 3', 8000)
      await A.setRaw({ role: 'textfield', name: 'Choose a passphrase' }, PASS)
      await A.setRaw({ role: 'textfield', name: 'Confirm passphrase' }, PASS)
      await waitFor(async () => !(await A.isDisabled(turnOn)), 8000, 'Turn on backup available')
      await A.click(turnOn)
      await A.waitText("You're protected", 120000)
      await A.waitText('Recovery key saved and checked', 8000)
      await A.shot('s160-done', runDir)
      await A.click({ role: 'button', name: 'Done' })
    })
    await r.ok('the status shows the backup and the key', async () => {
      await A.waitText('Protection', 8000)
      await A.waitText('Last backup', 60000)
      for (const sel of [
        { role: 'button', name: 'Back up now' },
        { role: 'button', name: 'Save a copy…' },
        { role: 'button', name: 'Check my passphrase' },
        { role: 'button', name: 'Change (backup folder)' },
      ]) {
        if (!(await A.has(sel))) throw new Error(`missing ${sel.role} ${sel.name}`)
      }
      await A.shot('s160-status', runDir)
    })
    await r.ok('the passphrase check confirms the key', async () => {
      await A.click({ role: 'button', name: 'Check my passphrase' })
      await A.setRaw({ role: 'textfield', name: 'Recovery passphrase' }, PASS)
      await A.click({ role: 'button', name: 'Check' })
      await A.waitText('Passphrase correct. Keep it safe.', 60000)
    })
    await r.ok('turning the backup off asks first, then offers setup again', async () => {
      await A.click({ role: 'button', name: 'Turn off backup' })
      await A.waitText('Turn off backup?', 8000)
      await A.click({ role: 'button', name: 'Turn off' })
      await A.waitText('Set up backup', 15000)
      if (!(await A.has({ role: 'button', name: 'Only save a recovery key file' }))) throw new Error('no key-only option')
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
