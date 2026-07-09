import { useTranslation } from 'react-i18next'
import type { SpaceMember } from '../../types.js'
import { formatSpeed, etaFromRate, joinMeta, progressValueText } from '../../utils.js'
import Avatar from '../primitives/Avatar.js'

interface PeerDownloadRowProps {
  member: SpaceMember | null
  bytes: number
  total: number
  avgSpeed: number
  paused?: boolean
}

export default function PeerDownloadRow({ member, bytes, total, avgSpeed, paused }: PeerDownloadRowProps) {
  const { t } = useTranslation()
  const name = member?.displayName || t('member.unknown')
  const online = member != null && member.online !== false
  const active = online && !paused
  const pct = total > 0 ? Math.min(100, Math.round((bytes / total) * 100)) : 0
  const speed = active && avgSpeed > 0 ? formatSpeed(avgSpeed) : null
  const eta = active ? etaFromRate(bytes, total, avgSpeed) : ''
  // Speed + ETA ride above the bar, right-aligned — same shape as the collapsed
  // indicator and DownloadProgressLane. Falls back to the percentage (never blank)
  // before the speed sampler has warmed up or once it decays to 0 on a stall.
  const meta = !online ? t('file.waiting') : paused ? t('file.paused') : (joinMeta(speed, eta) || `${pct}%`)
  // Mirror meta's online→paused ladder so the visible text and aria-valuetext can't
  // drift; the name already rides the progressbar's aria-label, so it's omitted here.
  const valueText = !online ? progressValueText(pct) : paused ? t('file.peerProgressPaused', { pct }) : progressValueText(pct, speed, eta)

  return (
    <li className="h-12 flex items-center gap-3 px-1">
      {/* Name, avatar, and the (speed · ETA over the bar) all cluster at the right edge:
          ml-auto pulls the name in next to the avatar instead of stranding it on the far
          left, the avatar sits next to the bar, and the meta is right-aligned above it. */}
      <span className={`min-w-0 ml-auto text-sm font-bold truncate ${online ? 'text-accent' : 'text-outline'}`}>{name}</span>
      <span className="relative shrink-0">
        <Avatar src={member?.avatar} displayName={name} size="sm" />
        <span
          aria-hidden="true"
          className={`absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border-2 border-surface-container-lowest ${online ? 'bg-online' : 'bg-offline'}`}
        />
      </span>
      <span className="w-1/2 shrink-0 flex flex-col justify-center gap-1">
        <span className="text-[11px] leading-none text-on-surface-variant tabular-nums text-right truncate">{meta}</span>
        <span
          role="progressbar"
          aria-label={t('file.peerProgress', { name })}
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuetext={valueText}
          className="block h-1.5 bg-surface-container-highest rounded-full overflow-hidden"
        >
          <span
            className={`block h-full rounded-full transition-all motion-reduce:transition-none ${active ? 'bg-on-info' : 'bg-on-info/40'}`}
            style={{ width: `${pct}%` }}
          />
        </span>
      </span>
    </li>
  )
}
