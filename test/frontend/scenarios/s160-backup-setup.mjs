import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { makeReport, waitFor } from '../assert.mjs'
import { setUpBackup } from '../helpers.mjs'

const PASS = 'a long enough passphrase'

// Set up from Settings → Backup in two steps; the status, the folder and the passphrase are on that one
// screen, which Profile → Backup also opens; the switch at its top turns the backup off after asking.
export default async function s160({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const backupDir = path.join(runDir, 's160-backup')
  mkdirSync(backupDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1 })
  const automatic = { role: 'switch', name: 'Back up automatically' }

  try {
    await r.ok('Settings offers Backup', async () => {
      await A.launch()
      await A.createSpaceOnly('Aurora')
      await A.gotoSettings('Backup')
      await A.waitText("Your spaces aren't backed up", 8000)
      if (String(await A.nodeValue(automatic)) !== '0') throw new Error('the switch starts off')
      await A.shot('s160-not-set-up', runDir)
    })
    await r.ok('setup takes a folder and a passphrase in two steps', async () => {
      await A.click({ role: 'button', name: 'Set up backup' })
      await setUpBackup(A, backupDir, PASS)
      await A.waitText("You're protected", 120000)
    })
    await r.ok('the one screen holds the status, the folder and the passphrase', async () => {
      for (const sel of [
        { role: 'button', name: 'Back up now' },
        { role: 'button', name: 'Change (backup folder)' },
        { role: 'button', name: 'Check passphrase' },
        { role: 'button', name: 'Change passphrase' },
        { role: 'switch', name: 'Remind me to check my passphrase' },
        automatic,
      ]) {
        if (!(await A.has(sel))) throw new Error(`missing ${sel.role} ${sel.name}`)
      }
      if (await A.hasText('recovery key')) throw new Error('the screen still speaks of a recovery key')
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
    await r.ok('the passphrase check confirms the key', async () => {
      await A.click({ role: 'button', name: 'Check passphrase' })
      await A.setRaw({ role: 'textfield', name: 'Passphrase' }, PASS)
      await A.click({ role: 'button', name: 'Check' })
      await A.waitText('Passphrase correct. Keep it safe.', 60000)
    })
    await r.ok('Profile → Backup opens the same screen', async () => {
      await A.openAccount()
      await A.click({ role: 'button', name: 'Backup' })
      await A.waitText("You're protected", 30000)
      if (!(await A.has({ role: 'button', name: 'Back up now' }))) throw new Error('not the Backup screen')
      await A.shot('s160-status', runDir)
    })
    await r.ok('the switch at the top turns the backup off after asking', async () => {
      if (String(await A.nodeValue(automatic)) !== '1') throw new Error(`the switch starts on (value ${await A.nodeValue(automatic)})`)
      await A.click(automatic)
      await A.waitText('Turn off backup?', 8000)
      await A.click({ role: 'button', name: 'Turn off' })
      await A.waitText("Your spaces aren't backed up", 15000)
      await waitFor(async () => String(await A.nodeValue(automatic)) === '0', 8000, 'the switch reads off')
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
