// The backup's state in one line, for the Settings row that leads to it.
import type { TFunction } from 'i18next'
import type { BackupStatus } from '../../../shared/contract/responses.js'
import { formatDateTime } from '../../format/utils.js'

export function backupSummary(status: BackupStatus, t: TFunction): string {
  if (status.state === 'paused') return t('settings.backupDescPaused')
  if (!status.folder) return t('settings.backupDescOff')
  if (status.stale || status.state === 'error' || !status.key.createdAt) return t('settings.backupDescAttention')
  return status.lastSuccessAt ? t('settings.backupDescOn', { when: formatDateTime(status.lastSuccessAt) }) : t('settings.backupDescPending')
}
