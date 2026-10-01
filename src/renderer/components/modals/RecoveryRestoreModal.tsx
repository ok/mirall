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
import TextButton from '../primitives/TextButton.js'
import Button from '../primitives/Button.js'
import Icon from '../primitives/Icon.js'
import ConfirmDestructiveModal from './ConfirmDestructiveModal.js'
import InlineError from '../primitives/InlineError.js'
import { readRecoveryHeader } from '../../../shared/contract/recovery-key.js'

interface RecoveryRestoreModalProps {
  isOpen: boolean
  onClose: () => void
  // Called once the key is adopted: the caller restarts the worker into it.
  onRestored: () => Promise<void>
}

interface ChosenFile {
  fileName: string
  content: string
  createdAt: string
}

export default function RecoveryRestoreModal({ isOpen, onClose, onRestored }: RecoveryRestoreModalProps) {
  const { t, i18n } = useTranslation()
  const errorText = useErrorText()
  const [file, setFile] = useState<ChosenFile | null>(null)
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmReplace, setConfirmReplace] = useState(false)

  function reset() {
    setFile(null)
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

  async function chooseFile() {
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
      setFieldError(null)
    } catch (err) {
      setError(errorText(err))
    }
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
  const createdMs = file ? Date.parse(file.createdAt) : NaN
  const created = Number.isNaN(createdMs) ? null : new Date(createdMs).toLocaleDateString(i18n.language)

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
            {error && !confirmReplace && (
              <div id="recovery-restore-error" className="rounded-xl bg-error-container/60 px-5 py-3 text-sm font-medium text-on-error-container" role="alert">
                {error}
              </div>
            )}
            <RecoveryFileChoice
              file={file}
              created={created}
              onChoose={() => void chooseFile()}
              onChange={() => { setFile(null); setPassphrase(''); setFieldError(null) }}
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
            <ModalFooter layout="split">
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

interface RecoveryFileChoiceProps {
  file: ChosenFile | null
  created: string | null
  onChoose: () => void
  onChange: () => void
}

// The chosen key, or the button that chooses one. Named by its label alone; the file-type hint is its
// description, so a screen reader hears one short name.
function RecoveryFileChoice({ file, created, onChoose, onChange }: RecoveryFileChoiceProps) {
  const { t } = useTranslation()
  if (file) {
    return (
      <div className="bg-surface-container-low rounded-xl p-4 flex items-center gap-4">
        <Icon name="description" className="text-secondary" />
        <div className="min-w-0 flex-1">
          <p className="font-bold text-on-surface truncate">{file.fileName}</p>
          {created && <p className="text-sm text-on-surface-variant">{t('recoveryRestore.createdAt', { date: created })}</p>}
        </div>
        <TextButton onClick={onChange}>{t('actions.change')}</TextButton>
      </div>
    )
  }
  return (
    <button
      type="button"
      onClick={onChoose}
      aria-label={t('recoveryRestore.chooseFile')}
      aria-describedby="recovery-restore-file-hint"
      className="w-full rounded-2xl border-2 border-dashed border-outline bg-surface-container-low p-8 text-center focus-ring"
    >
      <span className="block font-bold text-on-surface">{t('recoveryRestore.chooseFile')}</span>
      <span id="recovery-restore-file-hint" className="block mt-1 text-sm text-on-surface-variant">{t('recoveryRestore.fileHint')}</span>
    </button>
  )
}
