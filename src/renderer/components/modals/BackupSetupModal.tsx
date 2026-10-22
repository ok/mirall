// Setting up the backup in one sitting: where it lives, then the passphrase that opens it. The worker
// seals the backup's key into the folder and opens it back with the passphrase before the first
// backup, so a backup never exists that its passphrase cannot open. The outcome is a toast; the Backup
// screen carries the first run from there.
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
import Callout from '../primitives/Callout.js'
import FieldLabel from '../primitives/FieldLabel.js'
import PathRow from '../path/PathRow.js'
import BackupScopeList from '../backup/BackupScopeList.js'
import NewPassphraseFields from '../backup/NewPassphraseFields.js'
import ManagedNote from '../managed/ManagedNote.js'
import { useManagedBackupFolder, type ManagedBackupFolder } from '../../hooks/useManagedBackupFolder.js'
import type { BackupFolderChoice } from '../../platform/global.js'

interface BackupSetupModalProps {
  isOpen: boolean
  onClose: () => void
}

type Step = 1 | 2

export default function BackupSetupModal({ isOpen, onClose }: BackupSetupModalProps) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const toast = useToast()
  const [step, setStep] = useState<Step>(1)
  const [picked, setChosen] = useState<BackupFolderChoice | null>(null)
  // An organization's folder is set up as it is: nothing to pick, and the worker creates it empty.
  const managed = useManagedBackupFolder()
  const chosen: BackupFolderChoice | null = managed.folder ? { folder: managed.folder, sameDisk: false, otherFiles: false } : picked
  const [passphrase, setPassphrase] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const verdict = passphraseVerdict(passphrase, confirmation)
  // A folder that holds other files cannot be used at all, so the same-disk choice does not arise.
  const sameDisk = !!chosen?.sameDisk && !chosen.otherFiles

  function reset() {
    setStep(1)
    setChosen(null)
    setPassphrase('')
    setConfirmation('')
    setError(null)
    onClose()
  }

  function handleClose() {
    if (!busy) reset()
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

  // A typed folder gets the checks a picked one does: same disk, other files.
  async function takeFolder(typed: string) {
    setError(null)
    try {
      const inspected = await window.bridge.inspectBackupFolder(typed)
      if (inspected) setChosen(inspected)
      else setError(t('pathField.notFolder'))
    } catch (err) {
      setError(errorText(err))
    }
  }

  async function turnOn() {
    if (!chosen || verdict !== 'ok' || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await request('backup:setup', { folder: chosen.folder, passphrase }, 0)
      if (result.state === 'error') toast.error(t('backupSetup.doneFailed', { reason: errorText({ code: result.lastError ?? 'UNKNOWN' }) }))
      else toast.success(t(result.lastSuccessAt ? 'backupSetup.doneOn' : 'backupSetup.doneRunning'))
      setBusy(false)
      reset()
    } catch (err) {
      const offline = managed.folder && err instanceof Object && 'code' in err && err.code === 'BACKUP_TARGET_OFFLINE'
      setError(offline ? t('backup.managedShareOffline', { org: managed.org ?? '' }) : errorText(err))
      setBusy(false)
    }
  }

  function confirm() {
    if (step === 1 && chosen && !chosen.otherFiles) setStep(2)
    else if (step === 2) void turnOn()
  }

  const title = t(step === 1 ? 'backupSetup.title' : 'backupSetup.passphraseTitle')

  return (
    <Modal isOpen={isOpen} onClose={handleClose} onConfirm={confirm} isDismissable={!busy} ariaLabel={title}>
      <>
        <ModalHeader title={title} description={step === 1 ? t('backupSetup.intro') : undefined} descriptionSize="sm" onClose={handleClose} closeDisabled={busy} />
        <div className="px-10 pb-10 space-y-6">
          <p className="text-xs font-bold uppercase tracking-wide text-secondary">{t('backupSetup.step', { n: step, total: 2 })}</p>
          {error && (
            <div className="rounded-xl bg-error-container/60 px-5 py-3 text-sm font-medium text-on-error-container" role="alert">
              {error}
            </div>
          )}
          {step === 1 && (
            <>
              <BackupScopeList />
              <div className="space-y-3">
                <FieldLabel htmlFor="backup-setup-folder">{t('backupSetup.whereLabel')}</FieldLabel>
                <FolderField managed={managed} folder={chosen?.folder ?? null} onChoose={() => void chooseFolder()} onTake={(typed) => void takeFolder(typed)} />
              </div>
              {chosen?.otherFiles && <Callout tone="warning" role="status" id="backup-setup-other-files">{errorText({ code: 'BACKUP_TARGET_NOT_EMPTY' })}</Callout>}
              {sameDisk && (
                <Callout tone="warning" title={t('backupSetup.sameDiskTitle')}>{t('backupSetup.sameDiskBody')}</Callout>
              )}
              <ModalFooter>
                <Button variant="secondary" size="lg" onClick={handleClose}>{t('actions.cancel')}</Button>
                <Button size="lg" icon="arrow_forward" onClick={() => setStep(2)} disabled={!chosen || chosen.otherFiles} ariaDescribedBy={chosen?.otherFiles ? 'backup-setup-other-files' : undefined}>
                  {sameDisk ? t('backupSetup.useAnyway') : t('backupSetup.next')}
                </Button>
              </ModalFooter>
            </>
          )}
          {step === 2 && (
            <>
              <p className="text-sm text-on-surface leading-relaxed">{t('backupSetup.passphraseIntro')}</p>
              <NewPassphraseFields
                idPrefix="backup-setup"
                passphrase={passphrase}
                confirmation={confirmation}
                verdict={verdict}
                onPassphrase={setPassphrase}
                onConfirmation={setConfirmation}
              />
              <Callout tone="warning" title={t('backupSetup.keepSafeTitle')}>{t('backupSetup.keepSafeBody')}</Callout>
              {busy && <p role="status" className="text-sm text-on-surface-variant">{t('backupSetup.working')}</p>}
              <ModalFooter>
                <Button variant="secondary" size="lg" onClick={() => { setStep(1); setError(null) }} disabled={busy}>{t('actions.back')}</Button>
                <Button size="lg" icon="shield" onClick={() => void turnOn()} disabled={verdict !== 'ok'} ariaDisabled={busy}>{t('backupSetup.turnOn')}</Button>
              </ModalFooter>
            </>
          )}
        </div>
      </>
    </Modal>
  )
}

interface FolderFieldProps {
  managed: ManagedBackupFolder
  folder: string | null
  onChoose: () => void
  onTake: (typed: string) => void
}

function FolderField({ managed, folder, onChoose, onTake }: FolderFieldProps) {
  const { t } = useTranslation()
  if (!managed.folder) {
    return (
      <>
        <PathRow id="backup-setup-folder" path={folder} onAction={onChoose} onCommit={onTake} subject={t('backup.folderSubject')} ariaDescribedBy="backup-setup-folder-hint" />
        <p id="backup-setup-folder-hint" className="text-xs text-on-surface-variant px-1">{t('backupSetup.whereHint')}</p>
      </>
    )
  }
  return (
    <>
      <PathRow id="backup-setup-folder" path={managed.folder} ariaDescribedBy={`${managed.noteId} backup-setup-folder-hint`} />
      {managed.org && <ManagedNote id={managed.noteId} org={managed.org} className="px-1" />}
      <p id="backup-setup-folder-hint" className="text-xs text-on-surface-variant px-1">{t('backup.managedFolder')}</p>
    </>
  )
}
