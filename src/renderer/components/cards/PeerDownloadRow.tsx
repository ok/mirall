import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { SpaceMember } from '../../types/types.js'
import { formatSpeed, etaFromRate, joinMeta, progressValueText } from '../../format/utils.js'
import Avatar from '../primitives/Avatar.js'

interface PeerDownloadRowProps {
  member: SpaceMember | null
  bytes: number
  total: number
  avgSpeed: number
  paused?: boolean
  /** Waiting on a file we are still hashing: there is no progress yet, so the row shows none. */
  waiting?: boolean
}

// The pill shows the percentage; the speed · ETA it shortens rides the tooltip and aria-valuetext.
// Falls back to the percentage (never blank) before the speed sampler has warmed up. Offline and
// paused take the same ladder in all three, so the visible text and aria-valuetext can't drift.
interface PeerProgress {
  online: boolean
  paused: boolean
  pct: number
  speed: string | null
  eta: string
}

function peerLabels(t: TFunction, { online, paused, pct, speed, eta }: PeerProgress) {
  const held = !online ? t('file.waiting') : paused ? t('file.paused') : null
  return {
    meta: held ?? (joinMeta(speed, eta) || `${pct}%`),
    short: held ?? `${pct}%`,
    valueText: !online ? progressValueText(pct) : paused ? t('file.peerProgressPaused', { pct }) : progressValueText(pct, speed, eta),
  }
}

export default function PeerDownloadRow({ member, bytes, total, avgSpeed, paused, waiting }: PeerDownloadRowProps) {
  const { t } = useTranslation()
  const name = member?.displayName || t('member.unknown')
  const online = member != null && member.online !== false
  const active = online && !paused
  const pct = total > 0 ? Math.min(100, Math.round((bytes / total) * 100)) : 0
  const speed = active && avgSpeed > 0 ? formatSpeed(avgSpeed) : null
  const eta = active ? etaFromRate(bytes, total, avgSpeed) : ''
  const { meta, short, valueText } = peerLabels(t, { online, paused: paused === true, pct, speed, eta })

  return (
    <li title={waiting ? t('file.waitingForIndexing') : meta} className="max-w-full h-7 inline-flex items-center gap-1.5 pl-1 pr-2.5 rounded-full bg-surface-container-high group-hover:bg-surface-container-lowest dark:group-hover:bg-surface-container-high transition-colors">
      <span className="relative shrink-0">
        <Avatar src={member?.avatar} displayName={name} size="xs" />
        <span
          aria-hidden="true"
          className={`absolute -bottom-px -right-px w-2 h-2 rounded-full border-[1.5px] border-surface-container-high group-hover:border-surface-container-lowest dark:group-hover:border-surface-container-high transition-colors ${online ? 'bg-online' : 'bg-offline'}`}
        />
      </span>
      <span className="min-w-0 text-xs font-semibold text-on-surface-variant truncate">{name}</span>
      {waiting ? (
        <span className="shrink-0 text-[11px] leading-none text-on-surface-variant">{t('file.waitingForIndexing')}</span>
      ) : (
        <>
          <span
            role="progressbar"
            aria-label={t('file.peerProgress', { name })}
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuetext={valueText}
            className="w-12 shrink-0 block h-1.5 bg-progress-track rounded-full overflow-hidden"
          >
            <span
              className={`block h-full rounded-full transition-all motion-reduce:transition-none ${active ? 'bg-on-info' : 'bg-on-info/40'}`}
              style={{ width: `${pct}%` }}
            />
          </span>
          <span className="shrink-0 text-[11px] leading-none text-on-surface-variant tabular-nums">{short}</span>
        </>
      )}
    </li>
  )
}
