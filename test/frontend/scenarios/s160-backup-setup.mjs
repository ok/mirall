import { mkdirSync, writeFileSync } from 'node:fs'
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
  const clutteredDir = path.join(runDir, 's160-cluttered')
  mkdirSync(clutteredDir, { recursive: true })
  writeFileSync(path.join(clutteredDir, 'notes.txt'), 'mine')
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
    await r.ok('a folder that holds other files is refused at the first step', async () => {
      await A.click({ role: 'button', name: 'Set up backup' })
      await A.waitText('Step 1 of 2', 8000)
      await A.nativeChoosePath(clutteredDir, { trigger: () => A.click({ role: 'button', name: 'Browse… (backup folder)' }) })
      await A.waitText('This folder already holds other files', 8000)
      if (!(await A.isDisabled({ role: 'button', name: 'Next' }))) throw new Error('Next is available for a folder of other files')
      await A.shot('s160-other-files', runDir)
      await A.click({ role: 'button', name: 'Cancel' })
    })
    await r.ok('a typed folder gets the checks a picked one does', async () => {
      const field = { role: 'textfield', name: 'Where should the backup live?' }
      await A.click({ role: 'button', name: 'Set up backup' })
      await A.waitText('Step 1 of 2', 8000)
      // Setting a value through the AX tree does not move focus; a click puts Enter in the field.
      await A.click(field)
      await A.type(field, path.join(runDir, 's160-missing'))
      await A.press('return')
      await A.waitText('There is no folder at this path.', 8000)
      await A.type(field, clutteredDir)
      // Enter takes the typed path; it does not also press Next.
      await A.press('return')
      await A.waitText('This folder already holds other files', 8000)
      await A.waitText('Step 1 of 2', 2000)
      if (!(await A.isDisabled({ role: 'button', name: 'Next' }))) throw new Error('Next is available for a typed folder of other files')
      await A.shot('s160-typed-folder', runDir)
      await A.click({ role: 'button', name: 'Cancel' })
    })
    await r.ok('setup takes a folder and a passphrase in two steps', async () => {
      await A.click({ role: 'button', name: 'Set up backup' })
      await setUpBackup(A, backupDir, PASS)
      // The dialog closes once the passphrase is checked; the first backup runs on behind it.
      await A.waitText('The first backup is running', 8000)
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
