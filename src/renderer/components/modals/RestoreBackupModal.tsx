// Restoring from a backup folder on the locked screen or at onboarding: the folder, then the passphrase
// of the recovery key it keeps (or a key file, for a folder that keeps none); then one of the snapshots
// it holds. What the folder shows before any passphrase — a backup, its key's date, its newest backup's
// time — confirms it is the right one. The settings the backup carried go to main, and the worker
// restarts into the restored data, held until the people the user shares spaces with confirm it.
// Rendered outside the toast region, so every outcome is said inside the dialog.
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { request } from '../../ipc/ipc.js'
import { useErrorText } from '../../hooks/useErrorText.js'
import { errorCodeOf } from '../../errors/error-text.js'
import { useRecoveryFileChoice, type RecoveryFileChoiceState } from '../../hooks/useRecoveryFileChoice.js'
import { adoptRestoredSettings } from '../../platform/restored-settings.js'
import { snapshotLabel, type SnapshotLabel } from '../../model/snapshot-label.js'
import { formatDate, formatDateTime } from '../../format/utils.js'
import type { RestorableSnapshot, BackupPeek } from '../../../shared/contract/responses.js'
import Icon from '../primitives/Icon.js'
import Modal from '../primitives/Modal.js'
import ModalHeader from '../primitives/ModalHeader.js'
import ModalFooter from '../layout/ModalFooter.js'
import TextField from '../primitives/TextField.js'
import FieldLabel from '../primitives/FieldLabel.js'
import Button from '../primitives/Button.js'
import Callout from '../primitives/Callout.js'
import PathRow from '../path/PathRow.js'
import RadioCard from '../primitives/RadioCard.js'
import RecoveryFileChoice from '../recovery/RecoveryFileChoice.js'

interface RestoreBackupModalProps {
  isOpen: boolean
  onClose: () => void
  // Called once the restore is staged: the caller restarts the worker into it.
  onRestored: () => Promise<void>
}

// The newest snapshot the loss check did not flag: a flagged one is what the warning was about.
const preferred = (snapshots: RestorableSnapshot[]) => (snapshots.find((s) => !s.suspect) ?? snapshots[0])?.name ?? null

export default function RestoreBackupModal({ isOpen, onClose, onRestored }: RestoreBackupModalProps) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const keyFile = useRecoveryFileChoice()
  const [folder, setFolder] = useState<string | null>(null)
  const [peek, setPeek] = useState<BackupPeek | null>(null)
  const [passphrase, setPassphrase] = useState('')
  const [snapshots, setSnapshots] = useState<RestorableSnapshot[] | null>(null)
  const [chosen, setChosen] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // The folder's own key, or the key file chosen for a folder that keeps none — sent only then.
  const keyReady = !!peek?.keyCreatedAt || !!keyFile.file
  const content = peek?.keyCreatedAt ? undefined : keyFile.file?.content

  function reset() {
    keyFile.clear()
    setFolder(null)
    setPeek(null)
    setPassphrase('')
    setSnapshots(null)
    setChosen(null)
    setFieldError(null)
    setError(null)
    setRestarting(false)
  }

  function handleClose() {
    if (busy) return
    reset()
    onClose()
  }

  async function chooseFolder() {
    setError(null)
    try {
      const picked = await window.bridge.browseBackupFolder()
      if (!picked) return
      setFolder(picked.folder)
      setPeek(null)
      keyFile.clear()
      setPeek(await request('backup:peek', { folder: picked.folder }))
    } catch (err) {
      setError(errorText(err))
    }
  }

  // A wrong passphrase is said under its field, so the list step goes back to the form to show it.
  function fail(code: string | null, text: string) {
    if (code === 'WRONG_PASSPHRASE') {
      setSnapshots(null)
      setFieldError(text)
    } else {
      setError(text)
    }
  }

  async function showBackups() {
    if (!folder || !keyReady || !passphrase || busy) return
    setBusy(true)
    setFieldError(null)
    setError(null)
    try {
      const result = await request('backup:inspect', { folder, content, passphrase }, 0)
      setSnapshots(result.snapshots)
      setChosen(preferred(result.snapshots))
    } catch (err) {
      fail(errorCodeOf(err), errorText(err))
    } finally {
      setBusy(false)
    }
  }

  async function restore() {
    if (!folder || !keyReady || !chosen || busy) return
    setBusy(true)
    setError(null)
    try {
      const { settings } = await request('backup:restore', { folder, snapshot: chosen, content, passphrase }, 0)
      if (settings) await adoptRestoredSettings(settings)
      setRestarting(true)
      await onRestored()
      reset()
      onClose()
    } catch (err) {
      setRestarting(false)
      fail(errorCodeOf(err), errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const title = t('restoreBackup.title')
  const ready = !!folder && keyReady && passphrase.length > 0
  const shownError = error ?? keyFile.error
  const progress = restarting ? t('recoveryRestore.restarting') : busy ? t(snapshots ? 'restoreBackup.restoring' : 'restoreBackup.opening') : null

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      onConfirm={snapshots ? (chosen ? () => void restore() : undefined) : (ready ? () => void showBackups() : undefined)}
      isDismissable={!busy}
      ariaLabel={title}
    >
      <>
        <ModalHeader
          title={title}
          description={snapshots ? t('restoreBackup.introPick') : t('restoreBackup.introChoose')}
          descriptionSize="sm"
          onClose={handleClose}
          closeDisabled={busy}
        />
        <div className="px-10 pb-10 space-y-6">
          {shownError && (
            <div id="restore-backup-error" className="rounded-xl bg-error-container/60 px-5 py-3 text-sm font-medium text-on-error-container" role="alert">
              {shownError}
            </div>
          )}
          {!snapshots ? (
            <SourceFields
              folder={folder}
              peek={peek}
              keyFile={keyFile}
              passphrase={passphrase}
              fieldError={fieldError}
              busy={busy}
              onChooseFolder={() => void chooseFolder()}
              onChooseKey={() => { setError(null); setFieldError(null); void keyFile.choose() }}
              onPassphrase={(v) => { setPassphrase(v); setFieldError(null) }}
              onChangeKey={() => { keyFile.clear(); setPassphrase(''); setFieldError(null) }}
            />
          ) : (
            <>
              <SnapshotChoice snapshots={snapshots} chosen={chosen} onChoose={setChosen} />
              <Callout tone="note">{t('restoreBackup.caution')}</Callout>
            </>
          )}
          {progress && <p role="status" className="text-sm text-on-surface-variant">{progress}</p>}
          <ModalFooter>
            {snapshots ? (
              <>
                <Button variant="secondary" size="lg" onClick={() => { setSnapshots(null); setError(null) }} disabled={busy}>{t('actions.back')}</Button>
                <Button size="lg" onClick={() => void restore()} disabled={!chosen} ariaDisabled={busy}>{t('restoreBackup.restore')}</Button>
              </>
            ) : (
              <>
                <Button variant="secondary" size="lg" onClick={handleClose} disabled={busy}>{t('actions.cancel')}</Button>
                <Button size="lg" onClick={() => void showBackups()} disabled={!ready} ariaDisabled={busy}>{t('restoreBackup.showBackups')}</Button>
              </>
            )}
          </ModalFooter>
        </div>
      </>
    </Modal>
  )
}

interface SnapshotChoiceProps {
  snapshots: RestorableSnapshot[]
  chosen: string | null
  onChoose: (name: string) => void
}

// The snapshots a backup folder holds for this key, newest first, as one radio group. Focus moves to
// the chosen one when the list appears, since the button that showed it is gone. Each says why it is
// kept or how old it is; a flagged one says so in words beside its date.
function SnapshotChoice({ snapshots, chosen, onChoose }: SnapshotChoiceProps) {
  const { t, i18n } = useTranslation()
  const now = Date.now()
  const relative = new Intl.RelativeTimeFormat(i18n.language, { numeric: 'auto' })
  const list = new Intl.ListFormat(i18n.language, { type: 'conjunction' })
  const title = (label: SnapshotLabel) => {
    if (label.kind === 'latest') return t('restoreBackup.latest')
    if (label.kind === 'before-loss') return t('restoreBackup.beforeLoss')
    if (label.kind === 'before-leaving') return t('restoreBackup.beforeLeaving', { spaces: list.format(label.spaces.map((name) => t('restoreBackup.quoted', { name }))) })
    const text = relative.format(-label.value, label.unit)
    return text.charAt(0).toLocaleUpperCase(i18n.language) + text.slice(1)
  }
  const chosenRef = useRef<HTMLInputElement>(null)
  useEffect(() => { chosenRef.current?.focus() }, [])
  if (snapshots.length === 0) return <p className="text-on-surface-variant">{t('restoreBackup.none')}</p>
  return (
    <div role="radiogroup" aria-label={t('restoreBackup.listLabel')} className="space-y-2 max-h-64 overflow-y-auto scrollbar-thin">
      {snapshots.map((snapshot, index) => {
        const details = [
          formatDateTime(snapshot.createdAt),
          snapshot.spaces === null ? null : t('restoreBackup.spaces', { count: snapshot.spaces }),
          snapshot.suspect ? t('restoreBackup.flagged') : null,
        ].filter((part) => part !== null)
        return (
          <RadioCard key={snapshot.name} name="restore-backup-snapshot" checked={chosen === snapshot.name} onSelect={() => onChoose(snapshot.name)} inputRef={chosen === snapshot.name ? chosenRef : undefined}>
            <span className="min-w-0">
              <span className="block font-bold text-on-surface">{title(snapshotLabel(snapshot, index, now))}</span>
              <span className="block text-sm text-on-surface-variant">{details.join(' · ')}</span>
            </span>
          </RadioCard>
        )
      })}
    </div>
  )
}

interface SourceFieldsProps {
  folder: string | null
  peek: BackupPeek | null
  keyFile: RecoveryFileChoiceState
  passphrase: string
  fieldError: string | null
  busy: boolean
  onChooseFolder: () => void
  onChooseKey: () => void
  onChangeKey: () => void
  onPassphrase: (value: string) => void
}

// Where the backup is and what opens it. Nothing here can change while the dialog works on it.
function SourceFields({ folder, peek, keyFile, passphrase, fieldError, busy, onChooseFolder, onChooseKey, onChangeKey, onPassphrase }: SourceFieldsProps) {
  const { t } = useTranslation()
  const keyInFolder = !!peek?.keyCreatedAt
  const askPassphrase = keyInFolder || !!keyFile.file
  return (
    <>
      <div className="space-y-3">
        <FieldLabel id="restore-backup-folder-label">{t('restoreBackup.folderLabel')}</FieldLabel>
        <PathRow
          path={folder}
          onAction={onChooseFolder}
          subject={t('backup.folderSubject')}
          actionDisabled={busy}
        />
      </div>
      {peek && !peek.backup && <Callout tone="warning">{t('restoreBackup.noBackup')}</Callout>}
      {peek?.backup && (
        <div className="bg-surface-container-low rounded-xl p-4 flex items-center gap-3" role="status">
          <Icon name={keyInFolder ? 'verified_user' : 'info'} className="text-secondary" />
          <div>
            <p className="font-bold text-on-surface">{t(keyInFolder ? 'restoreBackup.found' : 'restoreBackup.foundNoKey')}</p>
            <p className="text-sm text-on-surface-variant">
              {keyInFolder && peek.keyCreatedAt
                ? t('restoreBackup.foundBody', { date: formatDate(peek.keyCreatedAt), when: peek.lastBackupAt ? formatDateTime(peek.lastBackupAt) : '—' })
                : t('restoreBackup.foundNoKeyBody')}
            </p>
          </div>
        </div>
      )}
      {peek?.backup && !keyInFolder && <RecoveryFileChoice file={keyFile.file} disabled={busy} onChoose={onChooseKey} onChange={onChangeKey} />}
      {peek?.backup && askPassphrase && (
        <TextField
          id="restore-backup-passphrase"
          label={t('recoveryRestore.passphraseLabel')}
          type="password"
          autoComplete="off"
          value={passphrase}
          onChange={onPassphrase}
          error={fieldError}
        />
      )}
    </>
  )
}
