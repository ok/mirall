import { progressValueText } from '../../utils.js'

interface DownloadProgressLaneProps {
  value: number
  label: string
  speed?: string
  eta?: string
  bytes?: string
  indeterminate?: boolean
  showPct?: boolean
}

// Meta shows speed + ETA while downloading, ETA alone while indexing, downloaded-so-far when
// paused, and the bare percentage while verifying (showPct) — where there is no speed/ETA/bytes
// to show and the scan still wants a concrete number. These tokens never co-occur. No aria-live:
// at the ~250ms cadence it would spam screen readers, so aria-valuenow/valuetext carry the state
// instead. While indeterminate (ETA warmup) the bar runs an indeterminate sweep and drops
// aria-valuenow per the ARIA progressbar contract. Animation respects reduced motion.
export default function DownloadProgressLane({ value, label, speed, eta, bytes, indeterminate, showPct }: DownloadProgressLaneProps) {
  const pct = Math.min(100, Math.max(0, Math.round(value) || 0))
  const speedTok = speed || undefined
  const etaTok = eta || undefined
  const bytesTok = bytes || undefined
  // Only when alone (verifying has no speed/ETA/bytes) — keeps the meta line single-token
  // so the percent can't concatenate onto another token without a separator.
  const pctTok = showPct && speedTok == null && etaTok == null && bytesTok == null ? `${pct}%` : undefined
  const valueText = progressValueText(pct, speedTok, etaTok, bytesTok)
  return (
    <div className="@container/lane w-full flex flex-col justify-center gap-1.5">
      <p className="text-[11px] leading-none text-on-surface-variant text-right truncate min-h-[11px]">
        {speedTok != null && (
          <span className="hidden @min-[150px]/lane:inline">{speedTok}{etaTok != null ? ' · ' : ''}</span>
        )}
        {etaTok != null && <span>{etaTok}</span>}
        {bytesTok != null && <span>{bytesTok}</span>}
        {pctTok != null && <span className="tabular-nums">{pctTok}</span>}
      </p>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={indeterminate ? undefined : pct}
        aria-valuetext={indeterminate ? etaTok : valueText}
        className="relative h-1.5 w-full bg-surface-container-highest rounded-full overflow-hidden"
      >
        {indeterminate ? (
          <div className="progress-indeterminate" />
        ) : (
          <div
            className="h-full bg-on-info rounded-full transition-all motion-reduce:transition-none"
            style={{ width: `${pct}%` }}
          />
        )}
      </div>
    </div>
  )
}
