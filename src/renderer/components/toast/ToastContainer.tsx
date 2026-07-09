import { useTranslation } from 'react-i18next'
import Toast from './Toast.js'
import type { ToastItem } from './types.js'

interface Props {
  items: ToastItem[]
  onDismiss: (id: string) => void
  onPause: (id: string) => void
  onResume: (id: string, remaining: number) => void
}

export default function ToastContainer({ items, onDismiss, onPause, onResume }: Props) {
  const { t } = useTranslation()
  return (
    <div
      role="region"
      aria-label={t('a11y.notifications')}
      className="pointer-events-none fixed inset-x-0 bottom-6 z-[60] flex flex-col items-center gap-2 px-4"
    >
      {items.map((item) => (
        <Toast
          key={item.id}
          item={item}
          onDismiss={() => onDismiss(item.id)}
          onPause={() => onPause(item.id)}
          onResume={(remaining) => onResume(item.id, remaining)}
        />
      ))}
    </div>
  )
}
