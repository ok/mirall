import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { formatSize, formatSpeed, resolveEta } from '../../utils.js'
import type { FileCardView } from '../../fileCardView.js'
import type { FileStatus, SpaceMember, PeerDownloadSummary } from '../../types.js'
import StatusBadge from '../primitives/StatusBadge.js'
import Badge from '../primitives/Badge.js'
import VerifiedCheck from '../primitives/VerifiedCheck.js'
import DownloadProgressLane from '../widgets/DownloadProgressLane.js'
import PeerDownloadIndicator from './PeerDownloadIndicator.js'

interface FileCardLaneProps {
  view: FileCardView
  members?: SpaceMember[]
  downloadSummary?: PeerDownloadSummary | null
  showDownloaders: boolean
  onToggleDownloaders: () => void
  dropdownId: string
}

export default function FileCardLane({ view, members, downloadSummary, showDownloaders, onToggleDownloaders, dropdownId }: FileCardLaneProps) {
  switch (view.lane) {
    case 'publish':
      return <PublishLane view={view} />
    case 'verify':
      return <VerifyLane view={view} />
    case 'download':
      return <DownloadLane view={view} />
    case 'preparing':
      return <PreparingLane view={view} />
    case 'indicator':
      return downloadSummary ? (
        <IndicatorLane
          summary={downloadSummary}
          members={members ?? []}
          open={showDownloaders}
          onToggle={onToggleDownloaders}
          controlsId={dropdownId}
        />
      ) : <RestLane view={view} />
    default:
      return <RestLane view={view} />
  }
}

function ProgressLaneShell({ status, basis = 'basis-32', children }: { status: FileStatus; basis?: string; children: ReactNode }) {
  return (
    <>
      <div className={`ml-6 ${basis} shrink-0 self-center`}>{children}</div>
      <div className="ml-5 mr-3 shrink-0 self-center items-center hidden @min-[480px]/row:flex">
        <StatusBadge status={status} />
      </div>
    </>
  )
}

function PublishLane({ view }: { view: FileCardView }) {
  const { t } = useTranslation()
  const eta = resolveEta(view.publishDecor?.eta)
  return (
    <ProgressLaneShell status={view.displayStatus}>
      <DownloadProgressLane
        value={view.publishPct}
        label={t('file.publishProgress')}
        eta={eta.etaText}
        indeterminate={!view.publishDecor || eta.indeterminate}
      />
    </ProgressLaneShell>
  )
}

function VerifyLane({ view }: { view: FileCardView }) {
  const { t } = useTranslation()
  return (
    <ProgressLaneShell status={view.displayStatus}>
      <DownloadProgressLane value={view.verifyPct} label={t('status.verifying')} showPct />
    </ProgressLaneShell>
  )
}

function DownloadLane({ view }: { view: FileCardView }) {
  const { t } = useTranslation()
  const eta = resolveEta(view.downloadDecor?.eta, view.downloadDecor?.avgSpeed)
  return (
    <ProgressLaneShell status={view.displayStatus} basis={view.isDownloading ? 'basis-40' : 'basis-32'}>
      <DownloadProgressLane
        value={view.downloadPct}
        label={t('file.downloadProgress')}
        speed={view.isDownloading && view.downloadDecor?.avgSpeed != null ? formatSpeed(view.downloadDecor.avgSpeed) : undefined}
        eta={view.isDownloading ? eta.etaText : undefined}
        indeterminate={view.isDownloading && eta.indeterminate}
        bytes={!view.isDownloading && view.progressBytes != null ? formatSize(view.progressBytes) : undefined}
      />
    </ProgressLaneShell>
  )
}

function PreparingLane({ view }: { view: FileCardView }) {
  const { t } = useTranslation()
  const eta = resolveEta(view.preparingDecor?.eta)
  return (
    <ProgressLaneShell status={view.displayStatus}>
      <DownloadProgressLane
        value={view.preparingPct}
        label={t('file.preparing')}
        eta={eta.etaText}
        indeterminate={eta.indeterminate}
      />
    </ProgressLaneShell>
  )
}

function IndicatorLane({ summary, members, open, onToggle, controlsId }: {
  summary: PeerDownloadSummary
  members: SpaceMember[]
  open: boolean
  onToggle: () => void
  controlsId: string
}) {
  const { t } = useTranslation()
  return (
    <>
      <div className="ml-6 basis-56 shrink min-w-[180px] self-center">
        <PeerDownloadIndicator
          summary={summary}
          members={members}
          open={open}
          onToggle={onToggle}
          controlsId={controlsId}
        />
      </div>
      <div className="ml-5 mr-3 shrink-0 self-center items-center hidden @min-[480px]/row:flex">
        <Badge label={t('file.sending')} classes="bg-info text-accent" />
      </div>
    </>
  )
}

function RestLane({ view }: { view: FileCardView }) {
  const { t } = useTranslation()
  return (
    <div className="shrink-0 ml-6 mr-3 flex items-center gap-2 self-center">
      {view.showVerified && <VerifiedCheck label={t('file.verified')} />}
      <StatusBadge status={view.displayStatus} />
    </div>
  )
}
