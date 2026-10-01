// The three safeguards on one card, each with its state in words and the one action that helps: the
// backup itself, the recovery key in the folder, and a copy of that key kept somewhere else.
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { BackupStatus } from '../../../shared/contract/responses.js'
import type { IconName } from '../../types/ui.js'
import Icon from '../primitives/Icon.js'
import Button from '../primitives/Button.js'
import { formatDateTime } from '../../format/utils.js'

type Health = 'ok' | 'attention' | 'tip'

const TILE: Record<Health, string> = {
  ok: 'bg-success text-on-success',
  attention: 'bg-warning-container text-on-warning-container',
  tip: 'bg-icon-tile text-on-icon-tile',
}

interface RowProps {
  icon: IconName
  health: Health
  label: string
  desc: string
  action?: ReactNode
}

function Row({ icon, health, label, desc, action }: RowProps) {
  return (
    <div className="p-6 flex items-center justify-between gap-4">
      <div className="flex items-center gap-4 min-w-0">
        <div className={`w-10 h-10 rounded-full ${TILE[health]} flex items-center justify-center shrink-0`}>
          <Icon name={icon} size={20} />
        </div>
        <div className="min-w-0">
          <p className="font-semibold text-accent">{label}</p>
          <p className="text-xs text-on-surface-variant">{desc}</p>
        </div>
      </div>
      {action}
    </div>
  )
}

interface ProtectionSummaryProps {
  status: BackupStatus
  onRunNow: () => void
  onSaveCopy: () => void
  savingCopy: boolean
}

export default function ProtectionSummary({ status, onRunNow, onSaveCopy, savingCopy }: ProtectionSummaryProps) {
  const { t } = useTranslation()
  const { key } = status
  const backupBad = status.stale || status.state === 'error'
  const backupDesc = status.state === 'running'
    ? t('backup.running')
    : status.lastSuccessAt
      ? t(status.stale ? 'backup.rowBackupStale' : 'backup.rowBackupOk', { when: formatDateTime(status.lastSuccessAt) })
      : t('backup.rowBackupNever')
  const keyDesc = !key.createdAt
    ? t('backup.rowKeyMissing')
    : !key.inFolder
      ? t('backup.rowKeyNotInFolder')
      : key.checkedAt
        ? t('backup.rowKeyOk', { when: formatDateTime(key.checkedAt) })
        : t('backup.rowKeyUnconfirmed')
  return (
    <div className="bg-surface-container-low rounded-xl overflow-hidden">
      <Row
        icon={backupBad ? 'warning' : 'check_circle'}
        health={backupBad ? 'attention' : 'ok'}
        label={t('backup.rowBackup')}
        desc={backupDesc}
        action={<Button variant="secondary" onClick={onRunNow} ariaDisabled={status.state === 'running'}>{t('backup.runNow')}</Button>}
      />
      <Row icon={key.createdAt ? 'verified_user' : 'warning'} health={key.createdAt && key.inFolder ? 'ok' : 'attention'} label={t('backup.rowKey')} desc={keyDesc} />
      <Row
        icon={key.secondCopyAt ? 'check_circle' : 'tips_and_updates'}
        health={key.secondCopyAt ? 'ok' : 'tip'}
        label={t('backup.rowCopy')}
        desc={key.secondCopyAt ? t('backup.rowCopyOk', { when: formatDateTime(key.secondCopyAt) }) : t('backup.rowCopyNone')}
        action={key.createdAt ? <Button variant="secondary" icon="download" onClick={onSaveCopy} ariaDisabled={savingCopy}>{t('backup.saveCopy')}</Button> : undefined}
      />
    </div>
  )
}
