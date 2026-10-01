// A new recovery key under a new passphrase, replacing the one in the backup folder. Copies saved
// elsewhere still open with the old passphrase, so the dialog says to delete them.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { request } from '../../ipc/ipc.js'
import { useErrorText } from '../../hooks/useErrorText.js'
import { useToast } from '../toast/ToastProvider.js'
import { passphraseVerdict } from '../../model/recovery-passphrase.js'
import Modal from '../primitives/Modal.js'
import ModalHeader from '../primitives/ModalHeader.js'
import ModalFooter from '../layout/ModalFooter.js'
import Button from '../primitives/Button.js'
import NewPassphraseFields from '../backup/NewPassphraseFields.js'

interface NewKeyModalProps {
  isOpen: boolean
  onClose: () => void
}

export default function NewKeyModal({ isOpen, onClose }: NewKeyModalProps) {
  const { t } = useTranslation()
  const toast = useToast()
  const errorText = useErrorText()
  const [passphrase, setPassphrase] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const verdict = passphraseVerdict(passphrase, confirmation)

  function reset() {
    setPassphrase('')
    setConfirmation('')
    setError(null)
  }

  function handleClose() {
    if (busy) return
    reset()
    onClose()
  }

  async function make() {
    if (verdict !== 'ok' || busy) return
    setBusy(true)
    setError(null)
    try {
      await request('backup:new-key', { passphrase }, 0)
      toast.success(t('backupNewKey.done'))
      setBusy(false)
      reset()
      onClose()
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }

  const title = t('backupNewKey.title')

  return (
    <Modal isOpen={isOpen} onClose={handleClose} onConfirm={verdict === 'ok' ? () => void make() : undefined} isDismissable={!busy} ariaLabel={title}>
      <>
        <ModalHeader title={title} description={t('backupNewKey.intro')} descriptionSize="sm" onClose={handleClose} closeDisabled={busy} />
        <div className="px-10 pb-10 space-y-6">
          {error && (
            <div className="rounded-xl bg-error-container/60 px-5 py-3 text-sm font-medium text-on-error-container" role="alert">
              {error}
            </div>
          )}
          <NewPassphraseFields
            idPrefix="backup-new-key"
            passphrase={passphrase}
            confirmation={confirmation}
            verdict={verdict}
            onPassphrase={setPassphrase}
            onConfirmation={setConfirmation}
          />
          {busy && <p role="status" className="text-sm text-on-surface-variant">{t('backupNewKey.working')}</p>}
          <ModalFooter layout="split">
            <Button variant="secondary" size="lg" onClick={handleClose} disabled={busy}>{t('actions.cancel')}</Button>
            <Button size="lg" onClick={() => void make()} disabled={verdict !== 'ok'} ariaDisabled={busy}>{t('backupNewKey.make')}</Button>
          </ModalFooter>
        </div>
      </>
    </Modal>
  )
}
