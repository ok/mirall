import { useTranslation } from 'react-i18next'
import type { SpaceMember, PeerDownloadSummary } from '../../types.js'
import { formatSpeed, etaFromRate, joinMeta, progressValueText } from '../../utils.js'
import Avatar from '../primitives/Avatar.js'
import Icon from '../primitives/Icon.js'

interface Downloader {
  key: string
  member: SpaceMember | null
  paused: boolean
}

interface PeerDownloadIndicatorProps {
  summary: PeerDownloadSummary
  members: SpaceMember[]
  open: boolean
  onToggle: () => void
  controlsId: string
}

const STACK_MAX = 3

interface MetaToken {
  key: string
  text: string
  className: string
}

// Ordered tokens for the collapsed meta line. They shed lowest-priority first under width
// pressure: the count word (the avatar stack already shows it) hides at the wide breakpoint,
// then ETA, while speed is always kept. The count word stays visible when it is the only
// token (all peers paused). Separators ride with the optional tokens around the always-on
// speed so a hidden token never strands a dot.
function metaTokens(countLabel: string, speed: string | null, eta: string): MetaToken[] {
  const hasRate = Boolean(speed || eta)
  const tokens: MetaToken[] = []
  if (countLabel) tokens.push({ key: 'count', text: countLabel + (hasRate ? ' · ' : ''), className: hasRate ? 'hidden @min-[200px]/lane:inline' : '' })
  if (speed) tokens.push({ key: 'speed', text: speed, className: 'tabular-nums' })
  if (eta) tokens.push({ key: 'eta', text: (speed ? ' · ' : '') + eta, className: 'tabular-nums hidden @min-[120px]/lane:inline' })
  return tokens
}

// Collapsed, always-visible indicator on an owned file's row: an overlapping avatar
// stack (up to three + "+N") and an aggregate progress bar. The whole thing is the
// toggle button for the per-peer dropdown.
export default function PeerDownloadIndicator({ summary, members, open, onToggle, controlsId }: PeerDownloadIndicatorProps) {
  const { t } = useTranslation()
  const pausedSet = summary.pausedKeys.length ? new Set(summary.pausedKeys) : null
  const downloaders: Downloader[] = summary.peerKeys
    .map((key) => ({ key, member: members.find((m) => m.publicKey === key) ?? null, paused: pausedSet?.has(key) ?? false }))
  const count = downloaders.length
  const pausedCount = downloaders.filter((d) => d.paused).length
  const allPaused = count > 0 && pausedCount === count
  const stack = downloaders.slice(0, STACK_MAX)
  const overflow = Math.max(0, count - STACK_MAX)
  const pct = summary.total > 0 ? Math.min(100, Math.round((summary.bytes / summary.total) * 100)) : 0
  const speed = !allPaused && summary.avgSpeed > 0 ? formatSpeed(summary.avgSpeed) : null
  // ETA is suppressed once ANY peer is paused: bytes/total are sums that include the
  // paused peers' frozen partials, but avgSpeed reflects only active throughput, so an
  // ETA would divide paused-inclusive remaining by active-only speed and never resolve.
  const eta = pausedCount > 0 ? '' : etaFromRate(summary.bytes, summary.total, summary.avgSpeed)
  const activeCount = count - pausedCount
  const activeLabel = activeCount > 0 ? t('file.downloadersCount', { count: activeCount }) : null
  const pausedLabel = pausedCount > 0 ? t('file.downloadersPaused', { count: pausedCount }) : null
  const countLabel = joinMeta(activeLabel, pausedLabel)
  const valueText = progressValueText(pct, activeLabel, pausedLabel, speed, eta)
  const tokens = metaTokens(countLabel, speed, eta)

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={open ? controlsId : undefined}
      aria-label={open ? t('file.hideDownloaders') : t('file.showDownloaders')}
      className="w-full flex items-center gap-3 rounded-lg p-1 -m-1 hover:bg-surface-container-high focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30"
    >
      {/* aria-valuetext on the bar carries every token regardless of what the line shows. */}
      <span className="@container/lane flex-grow min-w-0 flex flex-col gap-1.5">
        <span className="text-[11px] leading-none text-on-surface-variant text-right truncate min-h-[11px]">
          {tokens.map((tok) => (
            <span key={tok.key} data-token={tok.key} className={tok.className}>{tok.text}</span>
          ))}
        </span>
        <span className="flex items-center gap-3">
          <span className="flex items-center shrink-0" aria-hidden="true">
            {stack.map((d, i) => (
              <span key={d.key} className={`${i === 0 ? '' : '-ml-3'} ${d.paused ? 'opacity-50' : ''}`} title={d.member?.displayName || undefined}>
                <Avatar src={d.member?.avatar} displayName={d.member?.displayName} size="sm" ring="surface-container-lowest" decorative />
              </span>
            ))}
            {overflow > 0 && (
              <span
                style={{ boxShadow: '0 0 0 2px var(--color-surface-container-lowest)' }}
                className="-ml-3 w-8 h-8 rounded-full bg-surface-container-highest text-on-surface-variant flex items-center justify-center font-bold text-xs"
              >
                +{overflow}
              </span>
            )}
          </span>
          <span
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuetext={valueText}
            className="flex-grow block h-1.5 bg-progress-track rounded-full overflow-hidden"
          >
            <span
              className={`block h-full rounded-full transition-all motion-reduce:transition-none ${allPaused ? 'bg-on-info/40' : 'bg-on-info'}`}
              style={{ width: `${pct}%` }}
            />
          </span>
        </span>
      </span>
      <Icon
        name="chevron_right"
        size={18}
        className={`text-secondary shrink-0 transition-transform duration-200 motion-reduce:transition-none ${open ? 'rotate-90' : ''}`}
      />
    </button>
  )
}
