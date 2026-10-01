// Saving a recovery key: the worker seals the identity under the passphrase typed here, and main
// writes the sealed text wherever the user chooses. The plaintext key never reaches this window.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { request } from '../../ipc/ipc.js'
import { useErrorText } from '../../hooks/useErrorText.js'
import { useToast } from '../toast/ToastProvider.js'
import { passphraseVerdict } from '../../model/recovery-passphrase.js'
import { RECOVERY_PASSPHRASE_MIN } from '../../../shared/contract/recovery-key.js'
import Modal from '../primitives/Modal.js'
import ModalHeader from '../primitives/ModalHeader.js'
import ModalFooter from '../layout/ModalFooter.js'
import TextField from '../primitives/TextField.js'
import Button from '../primitives/Button.js'
import Icon from '../primitives/Icon.js'

interface RecoveryBackupModalProps {
  isOpen: boolean
  onClose: () => void
  // This device keeps its key without an OS keychain, so the backup is its real protection.
  weakProtection: boolean
}

export default function RecoveryBackupModal({ isOpen, onClose, weakProtection }: RecoveryBackupModalProps) {
  const { t } = useTranslation()
  const toast = useToast()
  const errorText = useErrorText()
  const [passphrase, setPassphrase] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const verdict = passphraseVerdict(passphrase, confirmation)

  function reset() {
    setPassphrase('')
    setConfirmation('')
    setError(null)
  }

  function handleClose() {
    if (saving) return
    reset()
    onClose()
  }

  async function handleSave() {
    if (verdict !== 'ok' || saving) return
    setSaving(true)
    setError(null)
    try {
      // Unbounded: sealing stretches the passphrase with Argon2id, which takes seconds.
      const sealed = await request('identity:export-recovery', { passphrase }, 0)
      const { saved } = await window.bridge.saveRecoveryFile(sealed)
      if (!saved) return
      toast.success(t('recoveryBackup.savedToast'))
      reset()
      onClose()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  const title = t('recoveryBackup.title')

  return (
    <Modal isOpen={isOpen} onClose={handleClose} onConfirm={() => void handleSave()} isDismissable={!saving} ariaLabel={title}>
      <>
        <ModalHeader title={title} description={t('recoveryBackup.intro')} descriptionSize="sm" onClose={handleClose} closeDisabled={saving} />
        <div className="px-10 pb-10 space-y-6">
          {error && (
            <div className="rounded-xl bg-error-container/60 px-5 py-3 text-sm font-medium text-on-error-container" role="alert">
              {error}
            </div>
          )}
          {weakProtection && (
            <p className="text-sm font-medium text-on-surface">{t('recoveryBackup.weakDevice')}</p>
          )}
          <TextField
            id="recovery-backup-passphrase"
            label={t('recoveryBackup.passphraseLabel')}
            type="password"
            autoComplete="new-password"
            autoFocus
            placeholder={t('recoveryBackup.passphrasePlaceholder', { min: RECOVERY_PASSPHRASE_MIN })}
            help={t('recoveryBackup.passphraseHelp')}
            value={passphrase}
            onChange={setPassphrase}
            error={verdict === 'too-short' && passphrase ? t('recoveryBackup.tooShort', { min: RECOVERY_PASSPHRASE_MIN }) : null}
          />
          <TextField
            id="recovery-backup-confirm"
            label={t('recoveryBackup.confirmLabel')}
            type="password"
            autoComplete="new-password"
            placeholder={t('recoveryBackup.confirmPlaceholder')}
            value={confirmation}
            onChange={setConfirmation}
            error={verdict === 'mismatch' && confirmation ? t('recoveryBackup.mismatch') : null}
          />
          <ul className="space-y-3 text-sm text-on-surface-variant">
            <li className="flex gap-3">
              <Icon name="check" size={18} className="text-secondary shrink-0" />
              <span><strong className="text-on-surface">{t('recoveryBackup.scopeRestoresLead')}</strong> {t('recoveryBackup.scopeRestores')}</span>
            </li>
            <li className="flex gap-3">
              <Icon name="info" size={18} className="text-secondary shrink-0" />
              <span><strong className="text-on-surface">{t('recoveryBackup.scopeExcludesLead')}</strong> {t('recoveryBackup.scopeExcludes')}</span>
            </li>
          </ul>
          <div className="bg-surface-container-high rounded-xl p-5 flex gap-3">
            <Icon name="warning" className="text-secondary shrink-0" />
            <div>
              <p className="font-bold text-on-surface">{t('recoveryBackup.warningsTitle')}</p>
              <ul className="mt-2 text-sm text-on-surface-variant list-disc pl-4 space-y-1">
                <li>{t('recoveryBackup.warningAccess')}</li>
                <li>{t('recoveryBackup.warningLostPassphrase')}</li>
                <li>{t('recoveryBackup.warningNotFiles')}</li>
              </ul>
            </div>
          </div>
          <ModalFooter layout="split">
            <Button variant="secondary" size="lg" onClick={handleClose} disabled={saving}>
              {t('actions.cancel')}
            </Button>
            <Button size="lg" icon="download" onClick={() => void handleSave()} disabled={verdict !== 'ok'} ariaDisabled={saving}>
              {saving ? t('actions.saving') : t('recoveryBackup.save')}
            </Button>
          </ModalFooter>
        </div>
      </>
    </Modal>
  )
}
