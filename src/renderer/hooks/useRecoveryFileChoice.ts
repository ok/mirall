// Choosing a recovery key file: the native picker through main, then the header read here so the
// dialog can show the file's name and date and refuse a file that is not a key, before any
// passphrase is asked for.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useErrorText } from './useErrorText.js'
import { readRecoveryHeader } from '../../shared/contract/recovery-key.js'

export interface ChosenRecoveryFile {
  fileName: string
  content: string
  createdAt: string
}

export interface RecoveryFileChoiceState {
  file: ChosenRecoveryFile | null
  error: string | null
  choose: () => Promise<void>
  clear: () => void
}

export function useRecoveryFileChoice(): RecoveryFileChoiceState {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const [file, setFile] = useState<ChosenRecoveryFile | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function choose() {
    setError(null)
    try {
      const pick = await window.bridge.openRecoveryFile()
      if (!pick.ok) {
        if (pick.reason === 'too-large') setError(t('recoveryRestore.notAKey'))
        return
      }
      const header = readRecoveryHeader(pick.content)
      if (!header) {
        setError(t('recoveryRestore.notAKey'))
        return
      }
      setFile({ fileName: pick.fileName, content: pick.content, createdAt: header.createdAt })
    } catch (err) {
      setError(errorText(err))
    }
  }

  return { file, error, choose, clear: () => { setFile(null); setError(null) } }
}
