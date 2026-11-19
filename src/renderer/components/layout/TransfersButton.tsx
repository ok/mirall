// The header's way into the transfers page, from any screen. A plain icon at rest; while bytes move
// it is a pill with the rate, download first and upload when only sending. Its name says how many
// transfers are under way, never the rate, which changes every second. A dot marks the one state
// the icon alone would hide: nothing is moving, yet a download is paused or failed.
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useTransfers } from '../../hooks/useTransfers.js'
import { useTransferRate } from '../../hooks/useTransferRate.js'
import { formatSpeed } from '../../format/utils.js'
import { transferCounts } from '../../model/transfers-view.js'
import Icon from '../primitives/Icon.js'
import IconButton from '../primitives/IconButton.js'

interface TransfersButtonProps {
  onClick: () => void
  /** The transfers page is the current screen. */
  current: boolean
}

// "999.9 MB/s": the widest figure the pill is sized for.
const WIDEST_RATE = 999.9 * 1000 * 1000

export default function TransfersButton({ onClick, current }: TransfersButtonProps) {
  const { t } = useTranslation()
  const transfers = useTransfers()
  const counts = useMemo(() => transferCounts(transfers), [transfers])
  const active = counts.downloading + counts.sending
  const waiting = active === 0 && counts.attention > 0
  const name = active > 0
    ? t('topnav.transfersActive', { count: active })
    : waiting ? t('topnav.transfersAttention', { count: counts.attention }) : t('topnav.transfers')
  const rate = useTransferRate()
  const speed = rate.down > 0 ? rate.down : rate.up
  if (speed > 0) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label={name}
        aria-current={current ? 'page' : undefined}
        title={t('topnav.transfers')}
        className={`h-10 shrink-0 flex items-center gap-1.5 rounded-full pl-2 pr-4 text-sm font-semibold tabular-nums text-on-surface-variant hover:bg-surface-control-hover active:scale-95 transition-all focus-ring ${current ? 'bg-surface-control-hover' : 'bg-surface-control'}`}
      >
        <Icon name="swap_vert" className="text-accent" />
        {/* The ghost reserves the widest rate, so the pill keeps one width while the number counts. */}
        <span aria-hidden="true" className="grid justify-items-end">
          <span className="col-start-1 row-start-1">{formatSpeed(speed)}</span>
          <span className="col-start-1 row-start-1 invisible">{formatSpeed(WIDEST_RATE)}</span>
        </span>
      </button>
    )
  }
  return (
    <span className="relative flex">
      <IconButton
        icon="swap_vert"
        onClick={onClick}
        ariaLabel={name}
        title={t('topnav.transfers')}
        ariaCurrent={current ? 'page' : undefined}
        className={current ? 'bg-surface-container-high' : undefined}
      />
      {waiting && (
        <span aria-hidden="true" className="absolute bottom-0.5 right-0.5 w-3 h-3 rounded-full border-2 border-surface-container-lowest bg-warning pointer-events-none" />
      )}
    </span>
  )
}
