import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { makeReport, waitFor } from '../assert.mjs'

const PASS = 'a long enough passphrase'

// Set up from Settings → Backup & recovery in one dialog; the status and its actions are then on
// Profile → Protection, and the configuration (passphrase reminder, turning off) stays in Settings.
export default async function s160({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const backupDir = path.join(runDir, 's160-backup')
  mkdirSync(backupDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1 })
  const turnOn = { role: 'button', name: 'Turn on backup' }

  try {
    await r.ok('Settings offers Backup & recovery', async () => {
      await A.launch()
      await A.createSpaceOnly('Aurora')
      await A.gotoSettings('Backup & Recovery')
      await A.waitText('Restoring on a new computer', 8000)
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
      await A.click({ role: 'button', name: 'Done' })
    })
    await r.ok('Settings holds the configuration', async () => {
      for (const sel of [
        { role: 'button', name: 'Change (backup folder)' },
        { role: 'button', name: 'Change passphrase…' },
        { role: 'switch', name: 'Remind me to check my passphrase' },
      ]) {
        if (!(await A.has(sel))) throw new Error(`missing ${sel.role} ${sel.name}`)
      }
      await A.shot('s160-settings', runDir)
    })
    await r.ok('the passphrase reminder is a switch that holds its state', async () => {
      const reminder = { role: 'switch', name: 'Remind me to check my passphrase' }
      // A switch reports its state as its AX value, "1" or "0".
      const on = async () => String(await A.nodeValue(reminder)) === '1'
      if (!(await on())) throw new Error(`reminders start on (value ${await A.nodeValue(reminder)})`)
      await A.click(reminder)
      await waitFor(async () => !(await on()), 8000, 'reminders off')
      await A.click(reminder)
      await waitFor(on, 8000, 'reminders on again')
    })
    await r.ok('Profile → Protection shows the status and its actions', async () => {
      await A.openAccount()
      await A.click({ role: 'button', name: 'Protection' })
      await A.waitText("You're protected", 30000)
      for (const sel of [
        { role: 'button', name: 'Check passphrase' },
        { role: 'button', name: 'Save a copy…' },
        { role: 'button', name: 'Back up now' },
      ]) {
        if (!(await A.has(sel))) throw new Error(`missing ${sel.role} ${sel.name}`)
      }
      await A.waitText('Copy of your recovery key', 8000)
      await A.shot('s160-status', runDir)
    })
    await r.ok('the passphrase check confirms the key', async () => {
      await A.click({ role: 'button', name: 'Check passphrase' })
      await A.setRaw({ role: 'textfield', name: 'Recovery passphrase' }, PASS)
      await A.click({ role: 'button', name: 'Check' })
      await A.waitText('Passphrase correct. Keep it safe.', 60000)
    })
    await r.ok('turning the backup off asks first, then offers setup again', async () => {
      await A.click({ role: 'button', name: 'Backup & Recovery Settings' })
      await A.click({ role: 'button', name: 'Turn off backup' })
      await A.waitText('Turn off backup?', 8000)
      await A.click({ role: 'button', name: 'Turn off' })
      await A.waitText('Set Up a Backup', 15000)
      if (!(await A.has({ role: 'button', name: 'Only save a recovery key file' }))) throw new Error('no key-only option')
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
