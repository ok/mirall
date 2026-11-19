// Every transfer on this device, across all spaces: the downloads the user asked for and the files
// members are fetching from it, grouped by space.
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { request } from '../ipc/ipc.js'
import { useHasVerticalOverflow } from '../hooks/useHasVerticalOverflow.js'
import { useRunAction } from '../hooks/useRunAction.js'
import { useSpaces } from '../hooks/useSpaces.js'
import { useTransfers } from '../hooks/useTransfers.js'
import { TRANSFER_FILTER, TRANSFER_FILTERS, filterTransfers, orderTransferSpaces, transferBulkVerb, transferCounts } from '../model/transfers-view.js'
import type { TransferFilter } from '../model/transfers-view.js'
import PageHeader from '../components/layout/PageHeader.js'
import Button from '../components/primitives/Button.js'
import SegmentedControl, { Segment } from '../components/primitives/SegmentedControl.js'
import TransferSpaceGroup from '../components/transfers/TransferSpaceGroup.js'
import SpeedCard from '../components/transfers/SpeedCard.js'
import TransferLimitsCard from '../components/transfers/TransferLimitsCard.js'

interface TransfersScreenProps {
  selfKey: string | null
  onBack: () => void
  onOpenSpace: (spaceId: string) => void
  onOpenNetworkSettings: () => void
}

const FILTER_LABEL: Record<TransferFilter, string> = {
  all: 'transfers.filterAll',
  downloading: 'transfers.filterDownloading',
  sending: 'transfers.filterSending',
  attention: 'transfers.filterAttention',
}

export default function TransfersScreen({ selfKey, onBack, onOpenSpace, onOpenNetworkSettings }: TransfersScreenProps) {
  const { t } = useTranslation()
  const { ref, hasOverflow } = useHasVerticalOverflow<HTMLDivElement>()
  const run = useRunAction()
  const transfers = useTransfers()
  const { spaces } = useSpaces()
  const [filter, setFilter] = useState<TransferFilter>(TRANSFER_FILTER.ALL)

  const spaceById = useMemo(() => new Map(spaces.map((s) => [s.spaceId, s])), [spaces])
  const counts = useMemo(() => transferCounts(transfers), [transfers])
  const groups = useMemo(
    () => orderTransferSpaces(filterTransfers(transfers, filter), (id) => spaceById.get(id)?.name ?? ''),
    [transfers, filter, spaceById],
  )
  const bulk = transferBulkVerb(transfers)
  const runBulk = useCallback(
    () => run(() => request(bulk === 'resume' ? 'transfers:resume-all' : 'transfers:pause-all', {}), 'transferFailed'),
    [run, bulk],
  )

  return (
    <div
      ref={ref}
      className={`relative h-[calc(100vh-5.5rem-var(--banner-h,0px))] overflow-y-auto scrollbar-thin pb-8 mr-2 ${hasOverflow ? 'pr-4' : ''}`}
    >
      <div className="pt-8 px-8 max-w-(--breakpoint-2xl) mx-auto">
        <div className="flex items-start justify-between gap-6">
          <PageHeader title={t('transfers.title')} subtitle={t('transfers.intro')} onBack={onBack} />
          {bulk && (
            <Button variant="secondary" icon={bulk === 'resume' ? 'play_arrow' : 'pause'} onClick={runBulk} className="mt-1 shrink-0">
              {t(bulk === 'resume' ? 'transfers.resumeAll' : 'transfers.pauseAll')}
            </Button>
          )}
        </div>

        <div className="grid grid-cols-[1fr_300px] gap-8">
          <div className="min-w-0">
            {counts.all === 0 ? (
              <div className="text-center pt-24">
                <h2 className="text-xl font-headline font-bold text-accent">{t('transfers.emptyTitle')}</h2>
                <p className="text-sm text-on-surface-variant mt-2">{t('transfers.emptyBody')}</p>
              </div>
            ) : (
              <>
                <SegmentedControl className="w-fit mb-5">
                  {TRANSFER_FILTERS.map((id) => {
                    const label = t(FILTER_LABEL[id])
                    return (
                      <Segment
                        key={id}
                        label={`${label} ${counts[id]}`}
                        ariaLabel={t('transfers.filterNamed', { label, count: counts[id] })}
                        selected={filter === id}
                        onSelect={() => setFilter(id)}
                      />
                    )
                  })}
                </SegmentedControl>
                {groups.length === 0 && (
                  <p role="status" className="text-sm text-on-surface-variant pt-8">{t('transfers.emptyFilter')}</p>
                )}
                {groups.map((group) => (
                  <TransferSpaceGroup
                    key={group.spaceId}
                    group={group}
                    space={spaceById.get(group.spaceId)}
                    selfKey={selfKey}
                    onOpenSpace={onOpenSpace}
                  />
                ))}
              </>
            )}
          </div>
          <aside className="space-y-6">
            <SpeedCard />
            <TransferLimitsCard onOpenNetworkSettings={onOpenNetworkSettings} />
          </aside>
        </div>
      </div>
    </div>
  )
}
