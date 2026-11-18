// The header's way into the transfers page, from any screen.
import { useTranslation } from 'react-i18next'
import IconButton from '../primitives/IconButton.js'

interface TransfersButtonProps {
  onClick: () => void
  /** The transfers page is the current screen. */
  current: boolean
}

export default function TransfersButton({ onClick, current }: TransfersButtonProps) {
  const { t } = useTranslation()
  return (
    <IconButton
      icon="swap_vert"
      iconSize={26}
      onClick={onClick}
      ariaLabel={t('topnav.transfers')}
      title={t('topnav.transfers')}
      ariaCurrent={current ? 'page' : undefined}
      className={current ? 'bg-surface-container-high' : undefined}
    />
  )
}
