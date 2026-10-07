import { mkdirSync, readdirSync, writeFileSync, lstatSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { makeReport, waitFor } from '../assert.mjs'
import { setUpBackup } from '../helpers.mjs'

const PASS = 'a long enough passphrase'

// kek.enc sits beside the store the app was given with --storage; found rather than assumed. lstat,
// because Electron leaves Singleton* symlinks in the profile that dangle once it has quit.
function findKek(dir, depth = 3) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (name === 'kek.enc') return p
    if (depth > 0 && lstatSync(p).isDirectory()) {
      const hit = findKek(p, depth - 1)
      if (hit) return hit
    }
  }
  return null
}

// A reset keychain: kek.enc no longer decrypts, so the app opens on the locked screen — not the
// fatal dialog, the fault screen or onboarding — and the backup set up earlier opens it again, the
// data unlocked in place.
export default async function s157({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1 })
  const backupDir = path.join(runDir, 's157-backup')
  mkdirSync(backupDir, { recursive: true })
  const passphrase = { role: 'textfield', name: 'Passphrase' }
  const showBackups = { role: 'button', name: 'Show backups' }

  try {
    await r.ok('set up a backup', async () => {
      await A.launch()
      await A.gotoSettings('Backup')
      await A.click({ role: 'button', name: 'Set up backup' })
      await setUpBackup(A, backupDir, PASS)
    })
    await r.ok('a keychain that cannot open kek.enc locks the data instead of stopping the app', async () => {
      await A.quit()
      const kek = findKek(A.store)
      if (!kek) throw new Error('kek.enc not found under the instance store')
      writeFileSync(kek, randomBytes(64))
      await A.launch({ onboard: false })
      await A.waitText("Mirall can't open your data", 45000)
      for (const name of ['Restore from a backup', 'Try again', 'Start fresh and create a new identity']) {
        if (!(await A.has({ role: 'button', name }))) throw new Error(`no button named ${name}`)
      }
      if (!readdirSync(path.dirname(kek)).some((n) => n.startsWith('kek.enc.unreadable-'))) throw new Error('the unreadable key was not kept')
      await A.shot('s157-locked', runDir)
    })
    await r.ok('a wrong passphrase is said under the field', async () => {
      await A.click({ role: 'button', name: 'Restore from a backup' })
      await A.nativeChoosePath(backupDir, { trigger: () => A.click({ role: 'button', name: 'Browse… (backup folder)' }) })
      await A.waitText('Found your backup', 15000)
      await A.setRaw(passphrase, 'not the passphrase')
      await waitFor(async () => !(await A.isDisabled(showBackups)), 8000, 'Show backups available')
      await A.click(showBackups)
      await A.waitText("That passphrase doesn't open this backup.", 60000)
      await A.shot('s157-wrong-passphrase', runDir)
    })
    await r.ok('the right passphrase unlocks the data in place', async () => {
      await A.setRaw(passphrase, PASS)
      await A.click(showBackups)
      await A.waitText('Your data is unlocked', 90000)
      await A.waitText('Create Space', 30000)
      await A.shot('s157-restored', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
