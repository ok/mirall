// The right-hand lane of a file row, for both row kinds: publish/verify/download/preparing
// progress, the sender-side who-is-downloading indicator, or the resting status pill. Which one is
// decided by rowView.js; this renders it.
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { formatSize, formatSpeed, resolveEta } from '../../utils.js'
import type { RowKind, RowView } from '../../rowView.js'
import type { SpaceMember, PeerDownloadSummary } from '../../types.js'
import Badge from '../primitives/Badge.js'
import VerifiedCheck from '../primitives/VerifiedCheck.js'
import DownloadProgressLane from '../widgets/DownloadProgressLane.js'
import PeerDownloadIndicator from './PeerDownloadIndicator.js'

interface RowLaneProps {
  view: RowView
  /** The file's own display name. The badge sits apart from it in the row, so on its own it
      announces a bare state with nothing tying it to what it describes. */
  rowName: string
  /** Which row this lane sits in; picks the lane width below. */
  kind: RowKind
  members?: SpaceMember[]
  downloadSummary?: PeerDownloadSummary | null
  showDownloaders: boolean
  onToggleDownloaders: () => void
  dropdownId: string
}

export default function RowLane({ view, rowName, kind, members, downloadSummary, showDownloaders, onToggleDownloaders, dropdownId }: RowLaneProps) {
  switch (view.lane) {
    case 'publish':
      return <PublishLane view={view} rowName={rowName} />
    case 'verify':
      return <VerifyLane view={view} rowName={rowName} />
    case 'download':
      return <DownloadLane view={view} rowName={rowName} />
    case 'preparing':
      return <PreparingLane view={view} rowName={rowName} />
    case 'indicator':
      return downloadSummary ? (
        <IndicatorLane
          summary={downloadSummary}
          members={members ?? []}
          rowName={rowName}
          kind={kind}
          open={showDownloaders}
          onToggle={onToggleDownloaders}
          controlsId={dropdownId}
        />
      ) : <RestLane view={view} rowName={rowName} />
    default:
      return <RestLane view={view} rowName={rowName} />
  }
}

function RowBadge({ label, classes, rowName }: { label: string; classes: string; rowName: string }) {
  const { t } = useTranslation()
  return (
    <Badge
      label={label}
      classes={classes}
      className="shrink-0"
      srLabel={t('file.rowStatusLabel', { name: rowName, status: label })}
    />
  )
}

function StatusPill({ view, rowName }: { view: RowView; rowName: string }) {
  const { t } = useTranslation()
  return <RowBadge label={t(view.badge.labelKey)} classes={view.badge.classes} rowName={rowName} />
}

function ProgressLaneShell({ view, rowName, basis = 'basis-32', children }: { view: RowView; rowName: string; basis?: string; children: ReactNode }) {
  return (
    <>
      <div className={`ml-6 ${basis} shrink-0 self-center`}>{children}</div>
      <div className="ml-5 mr-3 shrink-0 self-center items-center hidden @min-[480px]/row:flex">
        <StatusPill view={view} rowName={rowName} />
      </div>
    </>
  )
}

function PublishLane({ view, rowName }: { view: RowView; rowName: string }) {
  const { t } = useTranslation()
  const eta = resolveEta(view.publishDecor?.eta)
  return (
    <ProgressLaneShell view={view} rowName={rowName}>
      <DownloadProgressLane
        value={view.publishPct}
        label={t('file.indexingProgress')}
        eta={eta.etaText}
        indeterminate={!view.publishDecor || eta.indeterminate}
        // The one lane that can be indeterminate with no ETA to show: before the first frame there
        // is nothing to measure AND nothing to say, so without this the bar would expose neither
        // aria-valuenow nor aria-valuetext and read as an empty progressbar.
        indeterminateText={t('format.progressUnknown')}
      />
    </ProgressLaneShell>
  )
}

function VerifyLane({ view, rowName }: { view: RowView; rowName: string }) {
  const { t } = useTranslation()
  return (
    <ProgressLaneShell view={view} rowName={rowName}>
      <DownloadProgressLane value={view.verifyPct} label={t('status.verifying')} showPct />
    </ProgressLaneShell>
  )
}

function DownloadLane({ view, rowName }: { view: RowView; rowName: string }) {
  const { t } = useTranslation()
  const eta = resolveEta(view.downloadDecor?.eta, view.downloadDecor?.avgSpeed)
  return (
    <ProgressLaneShell view={view} rowName={rowName} basis={view.isDownloading ? 'basis-40' : 'basis-32'}>
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

function PreparingLane({ view, rowName }: { view: RowView; rowName: string }) {
  const { t } = useTranslation()
  const eta = resolveEta(view.preparingDecor?.eta)
  return (
    <ProgressLaneShell view={view} rowName={rowName}>
      <DownloadProgressLane
        value={view.preparingPct}
        label={t('file.indexingProgress')}
        eta={eta.etaText}
        indeterminate={eta.indeterminate}
      />
    </ProgressLaneShell>
  )
}

function IndicatorLane({ summary, members, rowName, kind, open, onToggle, controlsId }: {
  summary: PeerDownloadSummary
  members: SpaceMember[]
  rowName: string
  kind: RowKind
  open: boolean
  onToggle: () => void
  controlsId: string
}) {
  const { t } = useTranslation()
  // The share row's name column is narrower (it carries a leading gutter and a filter), so its
  // indicator gets more basis and sheds it faster. The 180px floor is shared and is the part that
  // keeps speed·ETA fitting.
  const width = kind === 'share' ? 'basis-72 shrink-[2]' : 'basis-56 shrink'
  return (
    <>
      <div className={`ml-6 ${width} min-w-[180px] self-center`}>
        <PeerDownloadIndicator
          summary={summary}
          members={members}
          open={open}
          onToggle={onToggle}
          controlsId={controlsId}
        />
      </div>
      <div className="ml-5 mr-3 shrink-0 self-center items-center hidden @min-[480px]/row:flex">
        <RowBadge label={t('file.sending')} classes="bg-info text-accent" rowName={rowName} />
      </div>
    </>
  )
}

function RestLane({ view, rowName }: { view: RowView; rowName: string }) {
  const { t } = useTranslation()
  return (
    <div className="shrink-0 ml-6 mr-3 flex items-center gap-2 self-center">
      {view.showVerified && <VerifiedCheck label={t('file.verified')} />}
      <StatusPill view={view} rowName={rowName} />
    </div>
  )
}
