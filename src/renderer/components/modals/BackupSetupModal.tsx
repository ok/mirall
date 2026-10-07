// Setting up the backup in one sitting: where it lives, the passphrase for the recovery key it keeps,
// and the result. The worker writes the key into the folder and opens it back with the passphrase
// before the first backup, so a backup never exists without a key known to open it.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { request } from '../../ipc/ipc.js'
import { useErrorText } from '../../hooks/useErrorText.js'
import { useSaveKeyCopy } from '../../hooks/useSaveKeyCopy.js'
import { passphraseVerdict } from '../../model/recovery-passphrase.js'
import type { BackupStatus } from '../../../shared/contract/responses.js'
import type { IconName } from '../../types/ui.js'
import Modal from '../primitives/Modal.js'
import ModalHeader from '../primitives/ModalHeader.js'
import ModalFooter from '../layout/ModalFooter.js'
import Button from '../primitives/Button.js'
import Callout from '../primitives/Callout.js'
import Icon from '../primitives/Icon.js'
import FieldLabel from '../primitives/FieldLabel.js'
import PathRow from '../path/PathRow.js'
import BackupScopeList from '../backup/BackupScopeList.js'
import NewPassphraseFields from '../backup/NewPassphraseFields.js'

interface BackupSetupModalProps {
  isOpen: boolean
  onClose: () => void
}

type Step = 1 | 2 | 3

interface Chosen {
  folder: string
  sameDisk: boolean
}

export default function BackupSetupModal({ isOpen, onClose }: BackupSetupModalProps) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const [step, setStep] = useState<Step>(1)
  const [chosen, setChosen] = useState<Chosen | null>(null)
  const [passphrase, setPassphrase] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<BackupStatus | null>(null)
  const verdict = passphraseVerdict(passphrase, confirmation)

  function handleClose() {
    if (busy) return
    setStep(1)
    setChosen(null)
    setPassphrase('')
    setConfirmation('')
    setError(null)
    setResult(null)
    onClose()
  }

  async function chooseFolder() {
    setError(null)
    try {
      const picked = await window.bridge.browseBackupFolder()
      if (picked) setChosen(picked)
    } catch (err) {
      setError(errorText(err))
    }
  }

  async function turnOn() {
    if (!chosen || verdict !== 'ok' || busy) return
    setBusy(true)
    setError(null)
    try {
      setResult(await request('backup:setup', { folder: chosen.folder, passphrase }, 0))
      setPassphrase('')
      setConfirmation('')
      setStep(3)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  function confirm() {
    if (step === 1 && chosen) setStep(2)
    else if (step === 2) void turnOn()
    else if (step === 3) handleClose()
  }

  const firstRunFailed = result?.state === 'error'
  const doneTitle = firstRunFailed ? 'backupSetup.doneTitleAttention' : 'backupSetup.doneTitle'
  const title = t(step === 1 ? 'backupSetup.title' : step === 2 ? 'backupSetup.keyTitle' : doneTitle)

  return (
    <Modal isOpen={isOpen} onClose={handleClose} onConfirm={confirm} isDismissable={!busy} ariaLabel={title}>
      <>
        <ModalHeader title={title} description={step === 1 ? t('backupSetup.intro') : undefined} descriptionSize="sm" onClose={handleClose} closeDisabled={busy} />
        <div className="px-10 pb-10 space-y-6">
          <p className="text-xs font-bold uppercase tracking-wide text-secondary">{t('backupSetup.step', { n: step, total: 3 })}</p>
          {error && (
            <div className="rounded-xl bg-error-container/60 px-5 py-3 text-sm font-medium text-on-error-container" role="alert">
              {error}
            </div>
          )}
          {step === 1 && (
            <>
              <BackupScopeList />
              <div className="space-y-3">
                <FieldLabel id="backup-setup-folder-label">{t('backupSetup.whereLabel')}</FieldLabel>
                <PathRow path={chosen?.folder ?? null} onAction={() => void chooseFolder()} subject={t('backup.folderSubject')} ariaDescribedBy="backup-setup-folder-hint" />
                <p id="backup-setup-folder-hint" className="text-xs text-on-surface-variant px-1">{t('backupSetup.whereHint')}</p>
              </div>
              {chosen?.sameDisk && (
                <Callout tone="warning" title={t('backupSetup.sameDiskTitle')}>{t('backupSetup.sameDiskBody')}</Callout>
              )}
              <ModalFooter>
                <Button variant="secondary" size="lg" onClick={handleClose}>{t('actions.cancel')}</Button>
                <Button size="lg" icon="arrow_forward" onClick={() => setStep(2)} disabled={!chosen}>
                  {chosen?.sameDisk ? t('backupSetup.useAnyway') : t('backupSetup.next')}
                </Button>
              </ModalFooter>
            </>
          )}
          {step === 2 && (
            <>
              <p className="text-sm text-on-surface leading-relaxed">{t('backupSetup.keyIntro')}</p>
              <NewPassphraseFields
                idPrefix="backup-setup"
                passphrase={passphrase}
                confirmation={confirmation}
                verdict={verdict}
                onPassphrase={setPassphrase}
                onConfirmation={setConfirmation}
              />
              <Callout tone="note" icon="warning" title={t('backupSetup.keepSafeTitle')}>{t('backupSetup.keepSafeBody')}</Callout>
              {busy && <p role="status" className="text-sm text-on-surface-variant">{t('backupSetup.working')}</p>}
              <ModalFooter>
                <Button variant="secondary" size="lg" onClick={() => { setStep(1); setError(null) }} disabled={busy}>{t('actions.back')}</Button>
                <Button size="lg" icon="shield" onClick={() => void turnOn()} disabled={verdict !== 'ok'} ariaDisabled={busy}>{t('backupSetup.turnOn')}</Button>
              </ModalFooter>
            </>
          )}
          {step === 3 && result && <SetupDone result={result} onDone={handleClose} />}
        </div>
      </>
    </Modal>
  )
}

// The outcome: the backup's first run and the key, said as they are, and the second copy offered.
function SetupDone({ result, onDone }: { result: BackupStatus; onDone: () => void }) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const copy = useSaveKeyCopy()
  return (
    <>
      <div className="space-y-3" role="status">
        {result.state === 'error' ? (
          <ResultRow icon="warning" title={t('backupSetup.doneBackupFailed')} body={errorText({ code: result.lastError ?? 'UNKNOWN' })} />
        ) : (
          <ResultRow
            icon="check_circle"
            title={t('backupSetup.doneBackup')}
            body={result.lastSuccessAt ? t('backupSetup.doneBackupBody', { folder: result.folder ?? '' }) : t('backupSetup.doneBackupPending')}
          />
        )}
        <ResultRow icon="verified_user" title={t('backupSetup.doneKey')} body={t('backupSetup.doneKeyBody')} />
      </div>
      <div className="rounded-xl p-5 bg-surface-container-low space-y-3">
        <p className="font-headline font-bold text-accent">{t('backupSetup.copyTitle')}</p>
        <p className="text-sm text-on-surface-variant leading-relaxed">{t('backupSetup.copyBody')}</p>
        <Button variant="secondary" icon="download" onClick={() => void copy.save()} ariaDisabled={copy.saving}>{t('backup.saveCopy')}</Button>
      </div>
      <ModalFooter>
        <Button size="lg" onClick={onDone}>{t('actions.done')}</Button>
      </ModalFooter>
    </>
  )
}

function ResultRow({ icon, title, body }: { icon: IconName; title: string; body: string }) {
  return (
    <div className="bg-surface-container-low rounded-xl p-4 flex items-center gap-3">
      <Icon name={icon} className="text-secondary" />
      <div>
        <p className="font-bold text-on-surface">{title}</p>
        <p className="text-sm text-on-surface-variant">{body}</p>
      </div>
    </div>
  )
}
