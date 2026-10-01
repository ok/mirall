// App Storage on the Storage screen: the whole data folder, a meter of what it holds, the "Free up"
// row when enough can be freed, and the rows behind a disclosure, each saying what frees it.
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useUpdateCacheInfo } from '../../hooks/useUpdateCacheInfo.js'
import { useFreeUpSpace } from '../../hooks/useFreeUpSpace.js'
import { formatSize } from '../../format/utils.js'
import { spaceBytes, storageCategories } from '../../model/storage-categories.js'
import type { StorageCategoryId } from '../../model/storage-categories.js'
import type { SpaceStorageUsage, StorageInfo } from '../../types/types.js'
import CopyButton from '../primitives/CopyButton.js'
import Icon from '../primitives/Icon.js'
import TextButton from '../primitives/TextButton.js'
import FilePath from '../path/FilePath.js'
import StorageMeter from './StorageMeter.js'
import StorageCategoryRow from './StorageCategoryRow.js'
import FreeUpRow from './FreeUpRow.js'

// One categorical slot per category, in meter order, shared by the segment and the row's dot. Other
// takes a hue too: the meter is full, and a grey segment would read as free space.
const CATEGORY_COLOR: Record<StorageCategoryId, string> = {
  spaces: 'bg-chart-1',
  index: 'bg-chart-2',
  'activity-log': 'bg-chart-3',
  'download-history': 'bg-chart-4',
  updates: 'bg-chart-5',
  other: 'bg-chart-6',
}

interface AppStorageCardProps {
  info: StorageInfo
  onOpenActivityLogSettings: () => void
  onOpenSpace: (spaceId: string) => void
}

function StorageTotal({ bytes, path }: { bytes: number; path: string }) {
  const [number, unit = 'B'] = formatSize(bytes).split(' ')
  return (
    <>
      <div className="flex items-baseline gap-2 mb-3">
        <span className="text-5xl font-headline font-extrabold text-accent tracking-tighter">{number}</span>
        <span className="text-xl font-headline font-bold text-on-surface-variant/60">{unit}</span>
      </div>
      <div className="flex items-center gap-2">
        <FilePath path={path} className="flex-1 text-xs font-medium text-on-surface-variant" />
        <CopyButton value={path} className="opacity-0 group-hover/copy:opacity-100 focus:opacity-100 transition-opacity" />
      </div>
    </>
  )
}

export default function AppStorageCard({ info, onOpenActivityLogSettings, onOpenSpace }: AppStorageCardProps) {
  const { t } = useTranslation()
  const { info: updates, refresh: refreshUpdates } = useUpdateCacheInfo()
  const freeUp = useFreeUpSpace(refreshUpdates)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const toggleDetails = useCallback(() => setDetailsOpen((open) => !open), [])

  const { total, spaces, categories, reclaimable, showFreeUp } = storageCategories(info, updates)
  const bytesOf = (id: StorageCategoryId) => categories.find((c) => c.id === id)?.bytes ?? 0
  const spaceName = (space: SpaceStorageUsage) => space.name || t('storageSettings.unnamedSpace')

  const heading: Record<StorageCategoryId, string> = {
    spaces: t('storageSettings.spaces'),
    index: t('storageSettings.sharingIndex'),
    'activity-log': t('storageSettings.activityLog'),
    'download-history': t('storageSettings.downloadHistory'),
    updates: t('storageSettings.updates'),
    other: t('storageSettings.other'),
  }
  const meterLabel = t('storageSettings.meterLabel', {
    list: categories.filter((c) => c.bytes > 0).map((c) => `${heading[c.id]} ${formatSize(c.bytes)}`).join(', '),
  })

  return (
    <div className="bg-surface-container-low rounded-xl">
      <div className="group/copy p-6">
        <StorageTotal bytes={total} path={info.folderPath} />
        <p className="text-sm text-on-surface-variant mt-3 leading-relaxed">{t('storageSettings.appStorageDesc')}</p>
        <StorageMeter
          segments={categories.map((c) => ({ id: c.id, bytes: c.bytes, color: CATEGORY_COLOR[c.id] }))}
          label={meterLabel}
        />
      </div>
      {(showFreeUp || freeUp.phase !== 'idle') && (
        <FreeUpRow reclaimable={reclaimable} phase={freeUp.phase} outcome={freeUp.outcome} onStart={() => freeUp.start(total)} />
      )}
      <button
        type="button"
        onClick={toggleDetails}
        aria-expanded={detailsOpen}
        aria-controls="appstorage-breakdown"
        className="w-full px-6 py-4 flex items-center justify-between text-left border-t border-outline-variant/40 focus-ring"
      >
        <span className="text-sm font-semibold text-on-surface-variant">{detailsOpen ? t('storageSettings.hideDetails') : t('storageSettings.showDetails')}</span>
        <Icon name={detailsOpen ? 'expand_more' : 'chevron_right'} className="text-outline" />
      </button>
      {detailsOpen && (
        <div id="appstorage-breakdown" className="px-6 pb-6 pt-2">
          <ul className="space-y-4">
            {spaces.map((space) => (
              <StorageCategoryRow
                key={space.spaceId}
                color={CATEGORY_COLOR.spaces}
                heading={space.name ? t('storageSettings.spaceRow', { name: space.name }) : t('storageSettings.unnamedSpace')}
                desc={t('storageSettings.spaceDesc', { own: formatSize(space.ownCatalogBytes), members: formatSize(space.memberCatalogBytes) })}
                bytes={spaceBytes(space)}
                action={(
                  <TextButton onClick={() => onOpenSpace(space.spaceId)} ariaLabel={t('storageSettings.openSpace', { name: spaceName(space) })}>
                    {t('storageSettings.open')}
                  </TextButton>
                )}
              />
            ))}
            <StorageCategoryRow color={CATEGORY_COLOR.index} heading={heading.index} desc={t('storageSettings.sharingIndexDesc')} bytes={bytesOf('index')} />
            <StorageCategoryRow
              color={CATEGORY_COLOR['activity-log']}
              heading={heading['activity-log']}
              desc={t('storageSettings.activityLogDesc')}
              bytes={bytesOf('activity-log')}
              action={<TextButton onClick={onOpenActivityLogSettings}>{t('storageSettings.manageActivityLog')}</TextButton>}
            />
            <StorageCategoryRow color={CATEGORY_COLOR['download-history']} heading={heading['download-history']} desc={t('storageSettings.downloadHistoryDesc')} bytes={bytesOf('download-history')} />
            <StorageCategoryRow color={CATEGORY_COLOR.updates} heading={heading.updates} desc={t('storageSettings.updatesDesc')} bytes={bytesOf('updates')} />
            <StorageCategoryRow color={CATEGORY_COLOR.other} heading={heading.other} desc={t('storageSettings.otherDesc')} bytes={bytesOf('other')} />
          </ul>
        </div>
      )}
    </div>
  )
}
