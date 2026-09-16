import { useTranslation } from 'react-i18next'
import type { ConnectivityState } from '../../types/types.js'

interface Props {
  state: ConnectivityState
  className?: string
}

// 'limited' is the one state without a semantic colour of its own: it is not a fault, so warning
// would overstate it, and it is not healthy either. The neutral container reads as "something to
// know" without competing with the two states the user must act on.
const COLOR: Record<ConnectivityState, string> = {
  online: 'bg-online',
  limited: 'bg-secondary-container',
  connecting: 'bg-warning',
  offline: 'bg-error',
}

// The presence dot MemberCard overlays on an avatar, here overlaid on the Connection row's icon
// tile. Named for assistive tech by the state, never by a visible label.
export default function StatusDot({ state, className }: Props) {
  const { t } = useTranslation()
  return (
    <span
      role="img"
      aria-label={t(`connectivity.${state}`)}
      className={`absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-surface-container-low ${COLOR[state]} ${className ?? ''}`}
    />
  )
}
