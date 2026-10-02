// The Protection row's verdict, overlaid on its tile the way the Connection row shows its state. Named
// for assistive tech by the verdict, never by colour alone.
import { useTranslation } from 'react-i18next'
import type { Lamp } from '../../model/protection-view.js'

const COLOR: Record<Lamp, string> = {
  protected: 'bg-online',
  'at-risk': 'bg-secondary-container',
  stopped: 'bg-error',
  paused: 'bg-outline',
}

export default function ProtectionDot({ lamp }: { lamp: Lamp }) {
  const { t } = useTranslation()
  return (
    <span
      role="img"
      aria-label={t(`protection.dot.${lamp}`)}
      className={`absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-surface-container-low ${COLOR[lamp]}`}
    />
  )
}
