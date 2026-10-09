import { useTranslation } from 'react-i18next'
import type { UpdateLamp } from '../../model/about-view.js'

const COLOR: Record<Exclude<UpdateLamp, 'neutral'>, string> = {
  'up-to-date': 'bg-online',
  ready: 'bg-secondary-container',
}

// The About row's update state, overlaid on its tile like the Connection and Backup dots.
export default function UpdateDot({ lamp }: { lamp: Exclude<UpdateLamp, 'neutral'> }) {
  const { t } = useTranslation()
  return (
    <span
      role="img"
      aria-label={t(`about.dot.${lamp}`)}
      className={`absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-surface-container-low ${COLOR[lamp]}`}
    />
  )
}
