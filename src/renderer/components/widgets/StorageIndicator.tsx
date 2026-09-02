// Not collapsible, and deliberately so: it is the SpaceView twin of the folder screen's
// FolderStatsCard, which cannot fold because its top-right corner is spoken for by the status
// badge. The pair that folds is the people one (Members here, People there); the pair that states
// a size does not.
import { useTranslation } from 'react-i18next'
import { formatSize } from '../../utils.js'
import Icon from '../primitives/Icon.js'
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
    <div className="bg-surface-container-low rounded-2xl p-8">
      <div className="flex items-center gap-2 mb-6">
        <Icon name="folder" className="text-secondary shrink-0" />
        <h3 className="text-xl font-headline font-bold text-accent">{t('storageIndicator.title')}</h3>
      </div>
      <div className="text-5xl font-headline font-extrabold text-accent tracking-tighter leading-none break-words">
        {formatSize(summary?.totalBytes ?? 0)}
      </div>
      <div className="mt-2 text-sm font-medium text-on-surface-variant">
        {t('storageIndicator.sizeOnDevice', { size: formatSize(summary?.onDeviceBytes ?? 0) })}
      </div>
    </div>
  )
}
