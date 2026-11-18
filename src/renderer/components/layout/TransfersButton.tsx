// The header's way into the transfers page, from any screen. Its name says how many transfers are
// under way; a dot marks the one state the icon alone would hide: nothing is moving, yet a download
// is paused or failed and waits for the user.
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useTransfers } from '../../hooks/useTransfers.js'
import { transferCounts } from '../../model/transfers-view.js'
import IconButton from '../primitives/IconButton.js'

interface TransfersButtonProps {
  onClick: () => void
  /** The transfers page is the current screen. */
  current: boolean
}

export default function TransfersButton({ onClick, current }: TransfersButtonProps) {
  const { t } = useTranslation()
  const transfers = useTransfers()
  const counts = useMemo(() => transferCounts(transfers), [transfers])
  const active = counts.downloading + counts.sending
  const waiting = active === 0 && counts.attention > 0
  const name = active > 0
    ? t('topnav.transfersActive', { count: active })
    : waiting ? t('topnav.transfersAttention', { count: counts.attention }) : t('topnav.transfers')
  return (
    <span className="relative flex">
      <IconButton
        icon="swap_vert"
        iconSize={26}
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
