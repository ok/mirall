// Backup: the one screen for it. The verdict leads with the one action that helps; below it the switch
// that turns the backup on or off, where it lives, and the passphrase that opens it. While a restore
// is being confirmed, its progress sits under the verdict. Switching the backup on runs the setup;
// switching it off asks first.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { request } from '../../ipc/ipc.js'
import { useBackupStatus } from '../../hooks/useBackupStatus.js'
import { useRestoreHold } from '../../hooks/useRestoreHold.js'
import { useErrorText } from '../../hooks/useErrorText.js'
import { useHasVerticalOverflow } from '../../hooks/useHasVerticalOverflow.js'
import { formatDateTime } from '../../format/utils.js'
import { protectionBanner, passphraseLine, type Fix } from '../../model/protection-view.js'
import type { BackupStatus } from '../../../shared/contract/responses.js'
import PageHeader from '../../components/layout/PageHeader.js'
import SectionHeading from '../../components/layout/SectionHeading.js'
import ActionRow from '../../components/layout/ActionRow.js'
import PathRow from '../../components/path/PathRow.js'
import Button from '../../components/primitives/Button.js'
import Toggle from '../../components/primitives/Toggle.js'
import Callout from '../../components/primitives/Callout.js'
import InlineError from '../../components/primitives/InlineError.js'
import ConfirmDestructiveModal from '../../components/modals/ConfirmDestructiveModal.js'
import VerdictBanner from '../../components/backup/VerdictBanner.js'
import RestoreProgress from '../../components/backup/RestoreProgress.js'
import BackupDialogs, { type BackupDialog } from '../../components/backup/BackupDialogs.js'

interface BackupSettingsProps {
  onBack: () => void
}

export default function BackupSettings({ onBack }: BackupSettingsProps) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const status = useBackupStatus()
  const hold = useRestoreHold()
  const { ref, hasOverflow } = useHasVerticalOverflow<HTMLDivElement>()
  const [dialog, setDialog] = useState<BackupDialog>(null)
  const [confirmOff, setConfirmOff] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [offError, setOffError] = useState<string | null>(null)

  async function act(action: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  async function runNow() {
    if (status?.state === 'running') return
    setError(null)
    try {
      await request('backup:run', {}, 0)
    } catch (err) {
      setError(errorText(err))
    }
  }

  function fix(action: Fix) {
    if (action === 'run') void runNow()
    else if (action) setDialog(action)
  }

  async function turnOff() {
    if (busy) return
    setBusy(true)
    setOffError(null)
    try {
      await request('backup:turn-off', {})
      setConfirmOff(false)
    } catch (err) {
      setOffError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const restoring = hold.active || hold.heldSpaceIds.length > 0
  const banner = restoring ? { lamp: 'paused' as const, key: 'restoring', fix: null } : status ? protectionBanner(status) : null
  const setUp = !!status?.folder
  const configurable = !!status && !restoring && status.state !== 'paused'

  return (
    <div ref={ref} className={`relative h-[calc(100vh-5.5rem-var(--banner-h,0px))] overflow-y-auto scrollbar-thin pb-8 mr-2 ${hasOverflow ? 'pr-4' : ''}`}>
      <div className="pt-8 px-8 max-w-2xl mx-auto">
        <PageHeader title={t('backup.title')} subtitle={t('backup.subtitle')} onBack={onBack} />
        {banner && (
          <div className="space-y-10">
            <VerdictBanner banner={banner} when={status?.lastSuccessAt ?? null} running={status?.state === 'running'} onFix={fix} />
            {restoring && (
              <section>
                <SectionHeading>{t('restore.sectionTitle')}</SectionHeading>
                <RestoreProgress hold={hold} />
              </section>
            )}
            {status && <StatusNotes status={status} error={error} />}
            {configurable && (
              <section className="bg-surface-container-low rounded-xl overflow-hidden">
                <Toggle
                  label={t('backup.autoLabel')}
                  description={t('backup.autoDesc')}
                  checked={setUp}
                  disabled={busy}
                  onChange={(next) => (next ? setDialog('setup') : setConfirmOff(true))}
                />
              </section>
            )}
            {configurable && setUp && (
              <>
                <FolderSection status={status} busy={busy} onChange={() => void act(changeFolder)} />
                <PassphraseSection status={status} busy={busy} onDialog={setDialog} onReminders={(next) => void act(() => setReminders(next))} />
              </>
            )}
          </div>
        )}
      </div>
      <BackupDialogs open={dialog} onChange={setDialog} />
      <ConfirmDestructiveModal
        isOpen={confirmOff}
        title={t('backup.turnOffTitle')}
        body={t('backup.turnOffBody')}
        confirmLabel={t('backup.turnOffConfirm')}
        onClose={() => { setConfirmOff(false); setOffError(null) }}
        onConfirm={() => void turnOff()}
        busy={busy}
      >
        {offError && <InlineError>{offError}</InlineError>}
      </ConfirmDestructiveModal>
    </div>
  )
}

async function changeFolder() {
  const picked = await window.bridge.browseBackupFolder()
  if (picked) await request('backup:configure', { folder: picked.folder })
}

async function setReminders(enabled: boolean) {
  await request('backup:reminders', { enabled })
}

function StatusNotes({ status, error }: { status: BackupStatus; error: string | null }) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const failure = status.state === 'error' && status.lastError ? errorText({ code: status.lastError }) : null
  if (!failure && !error && !status.suspect) return null
  return (
    <div className="space-y-3">
      {failure && <InlineError>{failure}</InlineError>}
      {error && <InlineError>{error}</InlineError>}
      {status.suspect && (
        <Callout tone="warning" title={t('backup.suspectTitle')}>
          {t('backup.suspectBody', { reasons: status.suspect.map((reason) => t(`backup.reason.${reason}`)).join(', ') })}
        </Callout>
      )}
    </div>
  )
}

function FolderSection({ status, busy, onChange }: { status: BackupStatus; busy: boolean; onChange: () => void }) {
  const { t } = useTranslation()
  const offline = status.state === 'error' && status.lastError === 'BACKUP_TARGET_OFFLINE'
  return (
    <section>
      <SectionHeading>{t('backup.folderTitle')}</SectionHeading>
      <div className="bg-surface-container-low rounded-xl p-6 space-y-4">
        <p id="backup-folder-desc" className="text-sm text-on-surface-variant">{t('backup.folderDesc')}</p>
        <PathRow
          path={status.folder}
          onAction={onChange}
          subject={t('backup.folderSubject')}
          actionDisabled={busy}
          ariaDescribedBy="backup-folder-desc"
          fill="lowest"
        />
        <p className="text-xs text-on-surface-variant px-1">{offline ? t('backup.folderOffline') : t('backup.folderHint')}</p>
      </div>
    </section>
  )
}

interface PassphraseSectionProps {
  status: BackupStatus
  busy: boolean
  onDialog: (dialog: BackupDialog) => void
  onReminders: (enabled: boolean) => void
}

function PassphraseSection({ status, busy, onDialog, onReminders }: PassphraseSectionProps) {
  const { t } = useTranslation()
  const line = passphraseLine(status)
  const hasKey = !!status.key.createdAt
  return (
    <section>
      <SectionHeading>{t('backup.passphraseSection')}</SectionHeading>
      <div className="bg-surface-container-low rounded-xl overflow-hidden">
        <div className="p-6 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="font-semibold text-accent">{t('backup.passphraseRow')}</p>
            <p className="text-xs text-on-surface-variant">{t(line.key, line.at === null ? {} : { when: formatDateTime(line.at) })}</p>
          </div>
          <Button variant="secondary" onClick={() => onDialog(hasKey ? 'check' : 'new-key')}>
            {t(hasKey ? 'backup.checkPassphrase' : 'backup.choosePassphrase')}
          </Button>
        </div>
        <Toggle
          label={t('backup.remindersLabel')}
          description={t('backup.remindersDesc')}
          checked={status.key.reminders}
          disabled={!hasKey || busy}
          onChange={onReminders}
        />
        {hasKey && <ActionRow label={t('backup.changePassphrase')} desc={t('backup.changePassphraseDesc')} onClick={() => onDialog('new-key')} />}
      </div>
    </section>
  )
}
