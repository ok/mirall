// Protection: how this device keeps the identity and the data safe, and the actions that keep it so —
// like Network status, a verdict first, then the facts in two groups, then the way to the settings.
// Configuration (folder, passphrase, reminders) lives in Settings → Backup & recovery. While a restore
// is being confirmed it leads with the restore's details, which the top banner links to.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { request } from '../ipc/ipc.js'
import { useBackupStatus } from '../hooks/useBackupStatus.js'
import { useRestoreHold } from '../hooks/useRestoreHold.js'
import { useIdentityProtection } from '../hooks/useIdentityProtection.js'
import { useSaveKeyCopy } from '../hooks/useSaveKeyCopy.js'
import { useErrorText } from '../hooks/useErrorText.js'
import { useHasVerticalOverflow } from '../hooks/useHasVerticalOverflow.js'
import { formatDateTime } from '../format/utils.js'
import { IDENTITY_LINE, protectionBanner, recoveryKeyRow, keyCopyRow, type Fix, type Lamp } from '../model/protection-view.js'
import type { BackupStatus } from '../../shared/contract/responses.js'
import type { IdentityProtection } from '../platform/global.js'
import PageHeader from '../components/layout/PageHeader.js'
import SectionHeading from '../components/layout/SectionHeading.js'
import ActionRow, { ROW_GROUP } from '../components/layout/ActionRow.js'
import Button from '../components/primitives/Button.js'
import Callout from '../components/primitives/Callout.js'
import InlineError from '../components/primitives/InlineError.js'
import StatusRow from '../components/backup/StatusRow.js'
import RestoreProgress from '../components/backup/RestoreProgress.js'
import BackupDialogs, { type BackupDialog } from '../components/backup/BackupDialogs.js'

interface Props {
  onBack: () => void
  onOpenSettings: () => void
}

const LAMP: Record<Lamp, string> = {
  protected: 'bg-online ring-online/25',
  'at-risk': 'bg-secondary-container ring-secondary-container/30',
  stopped: 'bg-error ring-error/25',
  paused: 'bg-outline ring-outline/20',
}

const FIX_LABEL: Record<NonNullable<Fix>, string> = {
  setup: 'backup.setUp',
  check: 'protection.checkPassphrase',
  'new-key': 'backup.makeKey',
  run: 'backup.runNow',
}

export default function ProtectionStatusScreen({ onBack, onOpenSettings }: Props) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const status = useBackupStatus()
  const hold = useRestoreHold()
  const identity = useIdentityProtection()
  const copy = useSaveKeyCopy()
  const { ref, hasOverflow } = useHasVerticalOverflow<HTMLDivElement>()
  const [dialog, setDialog] = useState<BackupDialog>(null)
  const [error, setError] = useState<string | null>(null)

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

  const restoring = hold.active || hold.heldSpaceIds.length > 0
  const banner = restoring ? { lamp: 'paused' as const, key: hold.source === 'key' ? 'restoringKey' : 'restoring', fix: null } : status ? protectionBanner(status) : null

  return (
    <div ref={ref} className={`relative h-[calc(100vh-5.5rem-var(--banner-h,0px))] overflow-y-auto scrollbar-thin pb-8 mr-2 ${hasOverflow ? 'pr-4' : ''}`}>
      <div className="pt-8 px-8 max-w-2xl mx-auto">
        <PageHeader title={t('protection.title')} subtitle={t('protection.intro')} onBack={onBack} />
        {banner && (
          <div className="space-y-10">
            <VerdictBanner banner={banner} when={status?.lastSuccessAt ?? null} running={status?.state === 'running'} onFix={fix} />
            {restoring && (
              <section>
                <SectionHeading>{t('restore.sectionTitle')}</SectionHeading>
                <RestoreProgress hold={hold} />
              </section>
            )}
            {status && (
              <section>
                <SectionHeading>{t('protection.identityTitle')}</SectionHeading>
                <IdentityRows status={status} identity={identity} onAction={(action) => setDialog(action)} onSaveCopy={() => void copy.save()} savingCopy={copy.saving} />
              </section>
            )}
            {status && banner.lamp !== 'paused' && (
              <section>
                <SectionHeading>{t('protection.dataTitle')}</SectionHeading>
                <DataRows status={status} onRunNow={() => void runNow()} />
                {status.state === 'error' && status.lastError && <InlineError className="mt-3">{errorText({ code: status.lastError })}</InlineError>}
                {error && <InlineError className="mt-3">{error}</InlineError>}
                {status.suspect && (
                  <Callout tone="warning" title={t('backup.suspectTitle')} className="mt-4">
                    {t('backup.suspectBody', { reasons: status.suspect.map((reason) => t(`backup.reason.${reason}`)).join(', ') })}
                  </Callout>
                )}
              </section>
            )}
            <section>
              <div className={ROW_GROUP}>
                <ActionRow icon="settings" label={t('protection.openSettings')} desc={t('protection.openSettingsDesc')} onClick={onOpenSettings} />
              </div>
            </section>
          </div>
        )}
      </div>
      <BackupDialogs open={dialog} onChange={setDialog} />
    </div>
  )
}

interface VerdictBannerProps {
  banner: { lamp: Lamp; key: string; fix: Fix }
  when: number | null
  running: boolean
  onFix: (fix: Fix) => void
}

function VerdictBanner({ banner, when, running, onFix }: VerdictBannerProps) {
  const { t } = useTranslation()
  return (
    <section>
      <div className="bg-surface-container-low rounded-xl p-6 flex items-center gap-5">
        <span aria-hidden="true" className={`w-4 h-4 rounded-full shrink-0 ring-4 ${LAMP[banner.lamp]}`} />
        <div role="status" aria-live="polite" className="flex-1 min-w-0">
          <p className="text-2xl font-headline font-bold text-accent">{t(`protection.verdict.${banner.key}Title`)}</p>
          <p className="text-sm text-on-surface-variant mt-1">{t(`protection.verdict.${banner.key}Body`, { when: when ? formatDateTime(when) : '' })}</p>
        </div>
        {banner.fix && (
          <Button onClick={() => onFix(banner.fix)} ariaDisabled={banner.fix === 'run' && running}>
            {t(FIX_LABEL[banner.fix])}
          </Button>
        )}
      </div>
    </section>
  )
}

interface IdentityRowsProps {
  status: BackupStatus
  identity: IdentityProtection | null
  onAction: (action: 'check' | 'new-key') => void
  onSaveCopy: () => void
  savingCopy: boolean
}

function IdentityRows({ status, identity, onAction, onSaveCopy, savingCopy }: IdentityRowsProps) {
  const { t } = useTranslation()
  const keyRow = recoveryKeyRow(status)
  const copyRow = keyCopyRow(status)
  const when = (at: number | null) => (at === null ? {} : { when: formatDateTime(at) })
  return (
    <div className={ROW_GROUP}>
      {identity && (
        <StatusRow icon={identity === 'protected' ? 'verified_user' : 'info'} health={IDENTITY_LINE[identity].health} label={t('protection.identityKey')} desc={t(IDENTITY_LINE[identity].key)} />
      )}
      <StatusRow
        icon={keyRow.health === 'ok' ? 'verified_user' : 'warning'}
        health={keyRow.health}
        label={t('backup.rowKey')}
        desc={t(keyRow.key, when(keyRow.at))}
        action={keyRow.action && (
          <Button variant="secondary" onClick={() => onAction(keyRow.action === 'new-key' ? 'new-key' : 'check')}>
            {t(keyRow.action === 'new-key' ? 'backup.makeKey' : 'protection.checkPassphrase')}
          </Button>
        )}
      />
      <StatusRow
        icon={copyRow.health === 'ok' ? 'check_circle' : 'tips_and_updates'}
        health={copyRow.health}
        label={t('backup.rowCopy')}
        desc={t(copyRow.key, when(copyRow.at))}
        action={copyRow.canSave ? <Button variant="secondary" icon="download" onClick={onSaveCopy} ariaDisabled={savingCopy}>{t('backup.saveCopy')}</Button> : undefined}
      />
    </div>
  )
}

function DataRows({ status, onRunNow }: { status: BackupStatus; onRunNow: () => void }) {
  const { t } = useTranslation()
  if (!status.folder) {
    return <div className={ROW_GROUP}><StatusRow icon="warning" health="attention" label={t('backup.rowBackup')} desc={t('protection.dataNotBackedUp')} /></div>
  }
  const offline = status.state === 'error' && status.lastError === 'BACKUP_TARGET_OFFLINE'
  const backupBad = status.stale || status.state === 'error'
  const backupDesc = status.state === 'running'
    ? t('backup.running')
    : status.lastSuccessAt
      ? t(status.stale ? 'backup.rowBackupStale' : 'backup.rowBackupOk', { when: formatDateTime(status.lastSuccessAt) })
      : t('backup.rowBackupNever')
  return (
    <div className={ROW_GROUP}>
      <StatusRow
        icon={backupBad ? 'warning' : 'check_circle'}
        health={backupBad ? 'attention' : status.lastSuccessAt ? 'ok' : 'tip'}
        label={t('backup.rowBackup')}
        desc={backupDesc}
        action={<Button variant="secondary" onClick={onRunNow} ariaDisabled={status.state === 'running'}>{t('backup.runNow')}</Button>}
      />
      <StatusRow
        icon={offline ? 'warning' : 'folder_open'}
        health={offline ? 'attention' : 'tip'}
        label={t('backup.folderTitle')}
        desc={offline ? t('protection.folderOffline', { folder: status.folder }) : status.folder}
      />
    </div>
  )
}
