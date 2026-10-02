// A new recovery passphrase, typed twice, with the same rules and messages as the recovery-key backup.
import { useTranslation } from 'react-i18next'
import { RECOVERY_PASSPHRASE_MIN } from '../../../shared/contract/recovery-key.js'
import type { PassphraseVerdict } from '../../model/recovery-passphrase.js'
import TextField from '../primitives/TextField.js'

interface NewPassphraseFieldsProps {
  idPrefix: string
  passphrase: string
  confirmation: string
  verdict: PassphraseVerdict
  onPassphrase: (value: string) => void
  onConfirmation: (value: string) => void
}

export default function NewPassphraseFields({ idPrefix, passphrase, confirmation, verdict, onPassphrase, onConfirmation }: NewPassphraseFieldsProps) {
  const { t } = useTranslation()
  return (
    <>
      <TextField
        id={`${idPrefix}-passphrase`}
        label={t('recoveryBackup.passphraseLabel')}
        type="password"
        autoComplete="new-password"
        autoFocus
        placeholder={t('recoveryBackup.passphrasePlaceholder', { min: RECOVERY_PASSPHRASE_MIN })}
        help={t('backupSetup.passphraseHelp', { min: RECOVERY_PASSPHRASE_MIN })}
        value={passphrase}
        onChange={onPassphrase}
        error={verdict === 'too-short' && passphrase ? t('recoveryBackup.tooShort', { min: RECOVERY_PASSPHRASE_MIN }) : null}
      />
      <TextField
        id={`${idPrefix}-confirm`}
        label={t('recoveryBackup.confirmLabel')}
        type="password"
        autoComplete="new-password"
        placeholder={t('recoveryBackup.confirmPlaceholder')}
        value={confirmation}
        onChange={onConfirmation}
        error={verdict === 'mismatch' && confirmation ? t('recoveryBackup.mismatch') : null}
      />
    </>
  )
}
