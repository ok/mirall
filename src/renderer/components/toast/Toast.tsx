// A single toast: enter/leave transitions and a countdown ring that pauses on
// hover/focus; sticky toasts (duration <= 0) stay until dismissed.
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ToastItem, ToastVariant } from './types.js'
import Icon, { type IconName } from '../primitives/Icon.js'

interface VariantStyles {
  bg: string
  fg: string
  iconColor: string
  icon: IconName
}

// Body text uses the app's regular foreground (`on-surface-variant`) for every
// variant — status is conveyed by the container color and the icon, not by
// tinting the message text. `warning` is the exception: its container stays a
// bright yellow in dark mode too, where the light `on-surface-variant` would
// fail contrast, so it keeps the dark `on-warning`. The status hue lives on the
// icon via `iconColor`.
const VARIANT_STYLES: Record<ToastVariant, VariantStyles> = {
  error: { bg: 'bg-error-container', fg: 'text-on-surface-variant', iconColor: 'text-on-error-container', icon: 'error' },
  warning: { bg: 'bg-warning', fg: 'text-on-warning', iconColor: 'text-on-warning', icon: 'warning' },
  success: { bg: 'bg-success', fg: 'text-on-surface-variant', iconColor: 'text-on-success', icon: 'check_circle' },
  info: { bg: 'bg-info', fg: 'text-on-surface-variant', iconColor: 'text-on-info', icon: 'info' },
}

const LEAVE_TRANSITION_MS = 180
const RING_SIZE = 18
const RING_STROKE = 2
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS
const MIN_RESUME_DURATION = 1000

interface Props {
  item: ToastItem
  onDismiss: () => void
  onPause: () => void
  onResume: (remaining: number) => void
}

export default function Toast({ item, onDismiss, onPause, onResume }: Props) {
  const { t } = useTranslation()
  const [entered, setEntered] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [paused, setPaused] = useState(false)
  const [progress, setProgress] = useState(0)
  const remainingRef = useRef(item.duration)
  const lastResumeRef = useRef(Date.now())
  const elapsedMsRef = useRef(0)
  const tickStartRef = useRef(Date.now())
  const styles = VARIANT_STYLES[item.variant]

  useEffect(() => {
    const handle = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(handle)
  }, [])

  useEffect(() => {
    if (paused || leaving || item.duration <= 0) return
    tickStartRef.current = Date.now()
    let raf = 0
    const tick = (): void => {
      const now = Date.now()
      const totalElapsed = elapsedMsRef.current + (now - tickStartRef.current)
      const ratio = Math.min(totalElapsed / item.duration, 1)
      setProgress(ratio)
      if (ratio < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      elapsedMsRef.current += Date.now() - tickStartRef.current
    }
  }, [paused, leaving, item.duration])

  function handleDismiss(): void {
    if (leaving) return
    setLeaving(true)
    setTimeout(onDismiss, LEAVE_TRANSITION_MS)
  }

  function handleMouseEnter(): void {
    // Sticky toasts (duration <= 0) have no countdown to pause, and resuming would
    // re-arm a dismiss timer via onResume's MIN_RESUME_DURATION clamp — keep them sticky.
    if (paused || item.duration <= 0) return
    setPaused(true)
    const elapsed = Date.now() - lastResumeRef.current
    remainingRef.current = Math.max(remainingRef.current - elapsed, 0)
    onPause()
  }

  function handleMouseLeave(): void {
    if (!paused) return
    setPaused(false)
    lastResumeRef.current = Date.now()
    onResume(Math.max(remainingRef.current, MIN_RESUME_DURATION))
  }

  function handleFocus(): void {
    handleMouseEnter()
  }

  function handleBlur(e: React.FocusEvent<HTMLDivElement>): void {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) handleMouseLeave()
  }

  function handleActionClick(): void {
    if (item.action) {
      item.action.onClick()
      handleDismiss()
    }
  }

  const visible = entered && !leaving

  return (
    <div
      role={item.variant === 'error' ? 'alert' : 'status'}
      aria-live={item.variant === 'error' ? 'assertive' : 'polite'}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onFocus={handleFocus}
      onBlur={handleBlur}
      className={[
        'pointer-events-auto flex items-center gap-3',
        'min-w-[280px] max-w-[720px] rounded-lg px-4 py-3 shadow-lg',
        styles.bg,
        styles.fg,
        'transition-all duration-200 ease-out motion-reduce:transition-none',
        visible
          ? 'opacity-100 translate-y-0'
          : 'opacity-0 translate-y-2 motion-reduce:translate-y-0',
      ].join(' ')}
    >
      <Icon name={styles.icon} size={20} className={`shrink-0 ${styles.iconColor}`} />
      <span className="min-w-0 flex-1 text-sm leading-snug break-words">{item.message}</span>
      {item.action && (
        <button
          type="button"
          onClick={handleActionClick}
          className="shrink-0 rounded-lg px-2 py-1 text-sm font-medium underline underline-offset-2 active:scale-95 transition-all motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-current/40"
        >
          {item.action.label}
        </button>
      )}
      <ToastDismissButton progress={progress} label={t('actions.dismiss')} onDismiss={handleDismiss} />
    </div>
  )
}

function ToastDismissButton({ progress, label, onDismiss }: { progress: number; label: string; onDismiss: () => void }) {
  const [hover, setHover] = useState(false)
  const dashOffset = RING_CIRCUMFERENCE * (1 - progress)
  return (
    <button
      type="button"
      onClick={onDismiss}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      aria-label={label}
      className="relative shrink-0 w-7 h-7 rounded-full hover:bg-black/10 active:scale-95 transition-colors motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-current/40"
    >
      <span
        className={[
          'absolute inset-0 flex items-center justify-center',
          'transition-opacity duration-150 motion-reduce:transition-none',
          hover ? 'opacity-0' : 'opacity-100',
        ].join(' ')}
        aria-hidden
      >
        <svg width={RING_SIZE} height={RING_SIZE} viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}>
          <circle
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={RING_RADIUS}
            fill="none"
            stroke="currentColor"
            strokeOpacity={0.3}
            strokeWidth={RING_STROKE}
          />
          <circle
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={RING_RADIUS}
            fill="none"
            stroke="currentColor"
            strokeWidth={RING_STROKE}
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={dashOffset}
            strokeLinecap="round"
            transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
          />
        </svg>
      </span>
      <span
        className={[
          'absolute inset-0 flex items-center justify-center',
          'transition-opacity duration-150 motion-reduce:transition-none',
          hover ? 'opacity-100' : 'opacity-0',
        ].join(' ')}
        aria-hidden
      >
        <Icon name="close" size={18} />
      </span>
    </button>
  )
}
