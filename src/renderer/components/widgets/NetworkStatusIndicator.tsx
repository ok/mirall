import { useTranslation } from 'react-i18next'
import type { ConnectivityState } from '../../types.js'

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

const RING: Record<ConnectivityState, string> = {
  online: 'ring-2 ring-online/30',
  limited: 'ring-2 ring-secondary-container/30',
  connecting: 'ring-2 ring-warning/30',
  offline: 'ring-2 ring-error/30',
}

// The lamp on the Account screen. Named for assistive tech by the state, never by a visible label.
export default function NetworkStatusIndicator({ state, className }: Props) {
  const { t } = useTranslation()
  return (
    <span className={`inline-flex items-center gap-2 ${className ?? ''}`} role="img" aria-label={t(`connectivity.${state}`)}>
      <span className={`rounded-full w-4 h-4 ${COLOR[state]} ${RING[state]}`} aria-hidden="true" />
    </span>
  )
}
