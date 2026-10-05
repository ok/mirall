import { mkdirSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { makeReport, waitFor } from '../assert.mjs'

// Saving the recovery key on its own, from Settings → Backup & recovery before a backup is set up: Save
// stays unavailable until a long enough passphrase is typed twice, and the saved file is a sealed
// recovery key.
export default async function s158({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1 })
  const saveTo = path.join(runDir, 'alice.mirallkey')
  const save = { role: 'button', name: 'Save backup file…' }

  try {
    await r.ok('Backup & recovery offers the recovery key on its own', async () => {
      await A.launch()
      await A.gotoSettings('Backup & recovery')
      await A.click({ role: 'button', name: 'Only save a recovery key file' })
      await A.waitText('Keep this safe', 8000)
      await A.shot('s158-backup-open', runDir)
    })
    await r.ok('Save waits for a long enough passphrase, typed twice', async () => {
      await A.setRaw({ role: 'textfield', name: 'Choose a passphrase' }, 'short')
      await A.waitText('Use at least 10 characters.', 8000)
      await waitFor(async () => A.isDisabled(save), 8000, 'Save unavailable while too short')
      await A.setRaw({ role: 'textfield', name: 'Choose a passphrase' }, 'a long enough passphrase')
      await A.setRaw({ role: 'textfield', name: 'Confirm passphrase' }, 'a long enough passphrasX')
      await A.waitText("The passphrases don't match.", 8000)
      await waitFor(async () => A.isDisabled(save), 8000, 'Save unavailable while mismatched')
      await A.setRaw({ role: 'textfield', name: 'Confirm passphrase' }, 'a long enough passphrase')
      await waitFor(async () => !(await A.isDisabled(save)), 8000, 'Save available')
      await A.shot('s158-backup-valid', runDir)
    })
    await r.ok('the saved file is a sealed recovery key', async () => {
      await A.nativeChoosePath(saveTo, { trigger: () => A.click(save) })
      await A.waitText('Recovery key saved to your chosen location.', 30000)
      await waitFor(async () => existsSync(saveTo), 8000, 'file written')
      const file = JSON.parse(readFileSync(saveTo, 'utf-8'))
      if (file.type !== 'mirall-recovery-key' || !Array.isArray(file.slots)) throw new Error('not a recovery key')
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
