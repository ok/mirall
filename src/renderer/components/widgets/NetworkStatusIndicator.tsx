import { useTranslation } from 'react-i18next'
import type { ConnectivityState } from '../../types.js'

type IndicatorSize = 'sm' | 'md' | 'lg'

interface Props {
  state: ConnectivityState
  size?: IndicatorSize
  label?: boolean
  className?: string
}

const COLOR: Record<ConnectivityState, string> = {
  online: 'bg-online',
  limited: 'bg-secondary-container',
  connecting: 'bg-warning',
  offline: 'bg-error',
}

const DOT_SIZE: Record<IndicatorSize, string> = {
  sm: 'w-2 h-2',
  md: 'w-3 h-3',
  lg: 'w-4 h-4',
}

const RING: Record<ConnectivityState, string> = {
  online: 'ring-2 ring-online/30',
  limited: 'ring-2 ring-secondary-container/30',
  connecting: 'ring-2 ring-warning/30',
  offline: 'ring-2 ring-error/30',
}

export default function NetworkStatusIndicator({ state, size = 'sm', label = false, className }: Props) {
  const { t } = useTranslation()
  return (
    <span
      className={`inline-flex items-center gap-2 ${className ?? ''}`}
      role={label ? undefined : 'img'}
      aria-label={label ? undefined : t(`connectivity.${state}`)}
    >
      <span
        className={`rounded-full ${DOT_SIZE[size]} ${COLOR[state]} ${size === 'lg' ? RING[state] : ''}`}
        aria-hidden="true"
      />
      {label && <span className="text-sm font-medium text-accent">{t(`connectivity.${state}`)}</span>}
    </span>
  )
}
