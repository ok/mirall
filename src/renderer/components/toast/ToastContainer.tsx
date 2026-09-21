import { useLayoutEffect, useRef } from 'react'
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
  const regionRef = useRef<HTMLDivElement>(null)

  // Sticky toasts can stack past the window height; the region scrolls, and each change brings the
  // newest toast into view.
  useLayoutEffect(() => {
    const region = regionRef.current
    if (region) region.scrollTop = region.scrollHeight
  }, [items])

  return (
    <div
      ref={regionRef}
      role="region"
      aria-label={t('a11y.notifications')}
      className="pointer-events-none fixed inset-x-0 bottom-6 z-[60] flex max-h-[calc(100vh-3rem)] flex-col items-center gap-2 overflow-y-auto px-4 scrollbar-thin"
    >
      {items.map((item) => (
        <Toast
          key={`${item.id}:${item.seq}`}
          item={item}
          onDismiss={() => onDismiss(item.id)}
          onPause={() => onPause(item.id)}
          onResume={(remaining) => onResume(item.id, remaining)}
        />
      ))}
    </div>
  )
}
