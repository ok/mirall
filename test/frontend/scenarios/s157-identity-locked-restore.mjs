import { mkdirSync, readdirSync, writeFileSync, lstatSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { makeReport, waitFor } from '../assert.mjs'

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
// fatal dialog, the fault screen or onboarding — and the recovery key saved earlier opens it again.
export default async function s155({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1 })
  const keyFile = path.join(runDir, 'alice.mirallkey')
  const passphrase = { role: 'textfield', name: 'Passphrase' }
  const restore = { role: 'button', name: 'Restore identity' }

  try {
    await r.ok('back up the recovery key', async () => {
      await A.launch()
      await A.openAccount()
      await A.click({ role: 'button', name: 'Back up your recovery key' })
      await A.setRaw({ role: 'textfield', name: 'Choose a passphrase' }, PASS)
      await A.setRaw({ role: 'textfield', name: 'Confirm passphrase' }, PASS)
      await A.nativeChoosePath(keyFile, { trigger: () => A.click({ role: 'button', name: 'Save backup file…' }) })
      await A.waitText('Recovery key saved to your chosen location.', 30000)
    })
    await r.ok('a keychain that cannot open kek.enc locks the identity instead of stopping the app', async () => {
      await A.quit()
      const kek = findKek(A.store)
      if (!kek) throw new Error('kek.enc not found under the instance store')
      writeFileSync(kek, randomBytes(64))
      await A.launch({ onboard: false })
      await A.waitText('Your identity key is locked', 45000)
      for (const name of ['Restore from recovery key', 'Try again', 'Start fresh and create a new identity']) {
        if (!(await A.has({ role: 'button', name }))) throw new Error(`no button named ${name}`)
      }
      if (!readdirSync(path.dirname(kek)).some((n) => n.startsWith('kek.enc.unreadable-'))) throw new Error('the unreadable key was not kept')
      await A.shot('s157-locked', runDir)
    })
    await r.ok('a wrong passphrase is said under the field', async () => {
      await A.click({ role: 'button', name: 'Restore from recovery key' })
      await A.nativeChoosePath(keyFile, { trigger: () => A.click({ role: 'button', name: 'Choose recovery key file…' }) })
      await A.waitText('Enter the passphrase for this recovery key.', 8000)
      await A.setRaw(passphrase, 'not the passphrase')
      await A.click(restore)
      await A.waitText("That passphrase didn't match this recovery key. Check it and try again.", 60000)
      await A.shot('s157-wrong-passphrase', runDir)
    })
    await r.ok('the right passphrase restores the identity', async () => {
      await A.setRaw(passphrase, PASS)
      await waitFor(async () => !(await A.isDisabled(restore)), 8000, 'Restore available')
      await A.click(restore)
      await A.waitText('Create Space', 90000)
      await A.shot('s157-restored', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
