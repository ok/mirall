import { useTranslation } from 'react-i18next'
import Badge from './Badge.js'
import { badgeStyle, fileStatusToBadge } from '../../statusBadge.js'
import type { FileStatus } from '../../types.js'

interface StatusBadgeProps {
  status: FileStatus
}

export default function StatusBadge({ status }: StatusBadgeProps) {
  const { t } = useTranslation()
  const { classes, labelKey } = badgeStyle(fileStatusToBadge(status))
  return <Badge label={t(labelKey)} classes={classes} className="shrink-0" />
}
