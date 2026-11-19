// One space's transfers. The live progress, the downloaders and the roster are read per space, so
// each group owns them and its rows stay the rows a space screen shows.
import { useTranslation } from 'react-i18next'
import { useDecorations } from '../../hooks/useDecorations.js'
import { usePeerDownloads } from '../../hooks/usePeerDownloads.js'
import { useMembers } from '../../hooks/useMembers.js'
import { useTransferControls } from '../../hooks/useTransferControls.js'
import { gradientForSpaceId, joinMeta } from '../../format/utils.js'
import { spaceTransferSummary } from '../../model/transfers-view.js'
import { shareDecoKey } from '../../../shared/contract/decoration-key.js'
import type { Space } from '../../types/types.js'
import type { IconName } from '../../types/ui.js'
import type { TransferDownload, TransferSpace } from '../../../shared/contract/responses.js'
import Icon from '../primitives/Icon.js'
import TextButton from '../primitives/TextButton.js'
import TransferDownloadRow from './TransferDownloadRow.js'
import TransferServingRow from './TransferServingRow.js'

interface TransferSpaceGroupProps {
  group: TransferSpace
  /** Absent for a moment after a space is left, while its last rows clear. */
  space: Space | undefined
  selfKey: string | null
  onOpenSpace: (spaceId: string) => void
}

const decoKeyOf = (d: TransferDownload) => (d.kind === 'loose' ? d.file.path : shareDecoKey(d.shareId, d.file.relPath))

export default function TransferSpaceGroup({ group, space, selfKey, onOpenSpace }: TransferSpaceGroupProps) {
  const { t } = useTranslation()
  const { spaceId } = group
  const { getDecoration } = useDecorations('transfer', spaceId)
  const { getDownloadSummary } = usePeerDownloads(spaceId)
  const { members } = useMembers(spaceId)
  const { pauseDownload, cancelDownload } = useTransferControls()
  const name = space?.name ?? ''
  const summary = spaceTransferSummary(group)
  const line = joinMeta(
    t('transfers.groupCount', { count: summary.transfers }),
    summary.paused > 0 ? t('transfers.groupPaused', { count: summary.paused }) : null,
    summary.failed > 0 ? t('transfers.groupFailed', { count: summary.failed }) : null,
  )
  return (
    <section aria-label={name} className="mb-8">
      <div className="flex items-center gap-3 mb-3">
        <div className={`w-10 h-10 rounded-lg ${gradientForSpaceId(spaceId)} flex items-center justify-center shrink-0`}>
          <Icon name={(space?.icon as IconName) || 'hub'} size={20} className="text-on-primary" />
        </div>
        <div className="min-w-0 flex-grow">
          <h2 className="text-lg font-headline font-bold text-accent leading-tight truncate">{name}</h2>
          <p className="text-xs text-on-surface-variant tabular-nums">{line}</p>
        </div>
        <TextButton onClick={() => onOpenSpace(spaceId)} ariaLabel={t('transfers.openSpaceNamed', { name })}>
          {t('transfers.openSpace')}
        </TextButton>
      </div>
      <div className="space-y-2">
        {group.downloads.map((download) => (
          <TransferDownloadRow
            key={download.file.transferId}
            spaceId={spaceId}
            download={download}
            decoration={getDecoration(decoKeyOf(download))}
            members={members}
            onPause={pauseDownload}
            onCancel={cancelDownload}
          />
        ))}
        {selfKey && group.serving.map((serving) => (
          <TransferServingRow
            key={`${serving.shareId}:${serving.path}`}
            serving={serving}
            selfKey={selfKey}
            members={members}
            downloadSummary={getDownloadSummary(serving.path)}
          />
        ))}
      </div>
    </section>
  )
}
