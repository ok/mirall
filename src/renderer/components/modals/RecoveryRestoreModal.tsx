// Adopting a recovery key on the locked screen or at onboarding: choose the file, enter its
// passphrase, and the worker restarts into the identity it holds. Rendered outside the toast region,
// so every outcome is said inside the dialog.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { request } from '../../ipc/ipc.js'
import { useErrorText } from '../../hooks/useErrorText.js'
import { errorCodeOf } from '../../errors/error-text.js'
import Modal from '../primitives/Modal.js'
import ModalHeader from '../primitives/ModalHeader.js'
import ModalFooter from '../layout/ModalFooter.js'
import TextField from '../primitives/TextField.js'
import Button from '../primitives/Button.js'
import ConfirmDestructiveModal from './ConfirmDestructiveModal.js'
import InlineError from '../primitives/InlineError.js'
import RecoveryFileChoice from '../recovery/RecoveryFileChoice.js'
import { useRecoveryFileChoice } from '../../hooks/useRecoveryFileChoice.js'

interface RecoveryRestoreModalProps {
  isOpen: boolean
  onClose: () => void
  // Called once the key is adopted: the caller restarts the worker into it.
  onRestored: () => Promise<void>
}

export default function RecoveryRestoreModal({ isOpen, onClose, onRestored }: RecoveryRestoreModalProps) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const keyFile = useRecoveryFileChoice()
  const file = keyFile.file
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmReplace, setConfirmReplace] = useState(false)

  function reset() {
    keyFile.clear()
    setPassphrase('')
    setFieldError(null)
    setError(null)
    setConfirmReplace(false)
    setRestarting(false)
  }

  function handleClose() {
    if (busy) return
    reset()
    onClose()
  }

  async function restore(replace: boolean) {
    if (!file || !passphrase || busy) return
    setBusy(true)
    setFieldError(null)
    setError(null)
    try {
      // Unbounded: the key derivation takes seconds, and the worker spaces out repeated wrong passphrases.
      const result = await request('identity:import-recovery', { content: file.content, passphrase, replace }, 0)
      if (!result.ok) {
        setConfirmReplace(true)
        return
      }
      setConfirmReplace(false)
      setRestarting(true)
      await onRestored()
      reset()
      onClose()
    } catch (err) {
      setRestarting(false)
      if (errorCodeOf(err) === 'WRONG_PASSPHRASE') setFieldError(errorText(err))
      else setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const title = t('recoveryRestore.title')
  const shownError = error ?? keyFile.error

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={handleClose}
        onConfirm={file && passphrase ? () => void restore(false) : undefined}
        isDismissable={!busy}
        ariaLabel={title}
      >
        <>
          <ModalHeader
            title={title}
            description={file ? t('recoveryRestore.introPassphrase') : t('recoveryRestore.introChoose')}
            descriptionSize="sm"
            onClose={handleClose}
            closeDisabled={busy}
          />
          <div className="px-10 pb-10 space-y-6">
            {shownError && !confirmReplace && (
              <div id="recovery-restore-error" className="rounded-xl bg-error-container/60 px-5 py-3 text-sm font-medium text-on-error-container" role="alert">
                {shownError}
              </div>
            )}
            <RecoveryFileChoice
              file={file}
              disabled={busy}
              onChoose={() => { setError(null); setFieldError(null); void keyFile.choose() }}
              onChange={() => { keyFile.clear(); setPassphrase(''); setFieldError(null) }}
            />
            {file && (
              <TextField
                id="recovery-restore-passphrase"
                label={t('recoveryRestore.passphraseLabel')}
                type="password"
                autoComplete="off"
                autoFocus
                value={passphrase}
                onChange={(v) => { setPassphrase(v); setFieldError(null) }}
                error={fieldError}
              />
            )}
            {restarting && <p role="status" className="text-sm text-on-surface-variant">{t('recoveryRestore.restarting')}</p>}
            <ModalFooter>
              <Button variant="secondary" size="lg" onClick={handleClose} disabled={busy}>
                {t('actions.cancel')}
              </Button>
              <Button size="lg" onClick={() => void restore(false)} disabled={!file || !passphrase} ariaDisabled={busy}>
                {t('recoveryRestore.restore')}
              </Button>
            </ModalFooter>
          </div>
        </>
      </Modal>
      <ConfirmDestructiveModal
        isOpen={confirmReplace}
        title={t('recoveryRestore.mismatchTitle')}
        body={t('recoveryRestore.mismatchBody')}
        confirmLabel={t('recoveryRestore.mismatchConfirm')}
        onClose={() => setConfirmReplace(false)}
        onConfirm={() => void restore(true)}
        busy={busy}
      >
        {error && <InlineError id="recovery-replace-error">{error}</InlineError>}
      </ConfirmDestructiveModal>
    </>
  )
}
