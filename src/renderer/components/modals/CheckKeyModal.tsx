// Checking that the recovery passphrase is still known, against the key this device keeps, so a
// forgotten one is found while the computer still works and a new key can be made. Nothing is sent.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { request } from '../../ipc/ipc.js'
import { useErrorText } from '../../hooks/useErrorText.js'
import { errorCodeOf } from '../../errors/error-text.js'
import { useToast } from '../toast/ToastProvider.js'
import Modal from '../primitives/Modal.js'
import ModalHeader from '../primitives/ModalHeader.js'
import ModalFooter from '../layout/ModalFooter.js'
import TextField from '../primitives/TextField.js'
import TextButton from '../primitives/TextButton.js'
import Button from '../primitives/Button.js'

interface CheckKeyModalProps {
  isOpen: boolean
  onClose: () => void
  onForgot: () => void
}

export default function CheckKeyModal({ isOpen, onClose, onForgot }: CheckKeyModalProps) {
  const { t } = useTranslation()
  const toast = useToast()
  const errorText = useErrorText()
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  function finish() {
    setPassphrase('')
    setFieldError(null)
    setError(null)
    onClose()
  }

  function handleClose() {
    if (!busy) finish()
  }

  async function check() {
    if (!passphrase || busy) return
    setBusy(true)
    setFieldError(null)
    setError(null)
    try {
      await request('backup:check-key', { passphrase }, 0)
      toast.success(t('backupCheck.correct'))
      setBusy(false)
      finish()
    } catch (err) {
      if (errorCodeOf(err) === 'WRONG_PASSPHRASE') setFieldError(errorText(err))
      else setError(errorText(err))
      setBusy(false)
    }
  }

  async function optOut() {
    if (busy) return
    setBusy(true)
    try {
      await request('backup:prompt', { prompt: 'check', action: 'opt-out' })
      setBusy(false)
      finish()
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }

  const title = t('backupCheck.title')

  return (
    <Modal isOpen={isOpen} onClose={handleClose} onConfirm={passphrase ? () => void check() : undefined} isDismissable={!busy} ariaLabel={title}>
      <>
        <ModalHeader title={title} onClose={handleClose} closeDisabled={busy} />
        <div className="px-10 pb-10 space-y-6">
          {error && (
            <div className="rounded-xl bg-error-container/60 px-5 py-3 text-sm font-medium text-on-error-container" role="alert">
              {error}
            </div>
          )}
          <TextField
            id="backup-check-passphrase"
            label={t('backupCheck.label')}
            type="password"
            autoComplete="off"
            autoFocus
            help={t('backupCheck.body')}
            value={passphrase}
            onChange={(v) => { setPassphrase(v); setFieldError(null) }}
            error={fieldError}
          />
          <div className="flex flex-col items-start gap-2">
            <TextButton onClick={() => { if (!busy) { finish(); onForgot() } }}>{t('backup.newKey')}</TextButton>
            <TextButton onClick={() => void optOut()}>{t('backupCheck.optOut')}</TextButton>
          </div>
          <ModalFooter>
            <Button variant="secondary" size="lg" onClick={handleClose} disabled={busy}>{t('actions.cancel')}</Button>
            <Button size="lg" onClick={() => void check()} disabled={!passphrase} ariaDisabled={busy}>{t('backupCheck.check')}</Button>
          </ModalFooter>
        </div>
      </>
    </Modal>
  )
}
