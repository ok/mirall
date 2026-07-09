import { useTranslation } from 'react-i18next'
import { formatSize } from '../../utils.js'
import CollapsibleCard from '../primitives/CollapsibleCard.js'
import { useSpaceStorage } from '../../hooks/useSpaceStorage.js'

interface StorageIndicatorProps {
  spaceId: string
}

export default function StorageIndicator({ spaceId }: StorageIndicatorProps) {
  const { t } = useTranslation()
  // Space-wide totals (folders + loose files); on-device is what is actually on
  // this disk — owned content fully, mirrors their materialized subset.
  const summary = useSpaceStorage(spaceId)

  return (
    <CollapsibleCard icon="folder" title={t('storageIndicator.title')}>
      <div className="text-5xl font-headline font-extrabold text-accent tracking-tighter leading-none break-words">
        {formatSize(summary?.totalBytes ?? 0)}
      </div>
      <div className="mt-2 text-sm font-medium text-on-surface-variant">
        {t('storageIndicator.sizeOnDevice', { size: formatSize(summary?.onDeviceBytes ?? 0) })}
      </div>
    </CollapsibleCard>
  )
}
