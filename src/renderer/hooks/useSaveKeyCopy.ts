// Saving another copy of the recovery key the backup keeps: the same sealed file, so it opens with the
// same passphrase, written wherever the user picks. The backup records that a copy exists.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { request } from '../ipc/ipc.js'
import { useErrorText } from './useErrorText.js'
import { useToast } from '../components/toast/ToastProvider.js'

export function useSaveKeyCopy() {
  const { t } = useTranslation()
  const toast = useToast()
  const errorText = useErrorText()
  const [saving, setSaving] = useState(false)

  async function save() {
    if (saving) return
    setSaving(true)
    try {
      const file = await request('backup:key-file', {})
      const { saved } = await window.bridge.saveRecoveryFile(file)
      if (!saved) return
      await request('backup:key-copied', {})
      toast.success(t('backup.copySaved'))
    } catch (err) {
      toast.error(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  return { save, saving }
}
