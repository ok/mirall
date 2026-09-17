// Peer/space avatar: an image when there is one, initials otherwise.
//
// The initials disc is a fill on whatever hosts it, and its hosts lift on hover, so it takes the
// hover-proof neutral rather than a ramp token one of them can adopt out from under it — the same
// reason the +N disc does (see the token note in design.md).
//
// `decorative` means a label sits next to it, so the avatar leaves the accessibility tree rather
// than reading the name twice. `ring='status'` requires a statusVariant — the ring IS the status,
// and without one it renders the neutral ring and says nothing.
import type { CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { getInitials } from '../../format/utils.js'

type AvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl'
type AvatarRing = 'none' | 'surface-container-lowest' | 'surface-container-low' | 'status'
type AvatarStatus = 'ok' | 'connecting' | 'offline'
type AvatarFallback = 'initials' | 'silhouette'

interface AvatarProps {
  src?: string | null
  displayName?: string | null
  size?: AvatarSize | number
  ring?: AvatarRing
  statusVariant?: AvatarStatus
  fallback?: AvatarFallback
  className?: string
  decorative?: boolean
}

const SIZE_PX: Record<AvatarSize, number> = {
  xs: 20,
  sm: 32,
  md: 36,
  lg: 48,
  xl: 80,
}

function resolveSize(size: AvatarSize | number): number {
  return typeof size === 'number' ? size : SIZE_PX[size]
}

function fontSizeFor(size: number): string {
  if (size <= 20) return '9px'
  if (size <= 32) return '12px'
  if (size <= 40) return '13px'
  if (size <= 56) return '16px'
  return '26px'
}

function ringFor(ring: AvatarRing, statusVariant: AvatarStatus): { className: string; style: CSSProperties } {
  if (ring === 'none') return { className: '', style: {} }
  if (ring === 'status') {
    if (statusVariant === 'offline') return { className: 'avatar-issue-pulse-error', style: {} }
    if (statusVariant === 'connecting') return { className: 'avatar-issue-pulse-warning', style: {} }
    return { className: '', style: { boxShadow: '0 0 0 2px var(--color-surface-container-highest)' } }
  }
  // The ring is a hole cut in the surface BEHIND the avatar, so it has to be that surface's
  // current fill. A host whose fill changes — a card that lifts on hover — hands the new one
  // over in `--avatar-ring`; the prop is the resting default for every host that does not.
  // `transition-shadow` because the ring rides a host's `transition-colors` fill and box-shadow is
  // not in that utility's property list: without it the hole snaps to the lifted colour while the
  // surface it is cut from is still fading, and for those 150ms the ring is a visible rim.
  return { className: 'transition-shadow', style: { boxShadow: `0 0 0 2px var(--avatar-ring, var(--color-${ring}))` } }
}

function AvatarSilhouette() {
  return (
    <svg viewBox="0 0 48 48" className="w-full h-full text-outline" fill="currentColor" aria-hidden="true">
      <circle cx="24" cy="19" r="7" />
      <path d="M10 48 V36 Q10 30 16 30 H32 Q38 30 38 36 V48 Z" />
    </svg>
  )
}

export default function Avatar({
  src,
  displayName,
  size = 'md',
  ring = 'none',
  statusVariant = 'ok',
  fallback = 'initials',
  className,
  decorative,
}: AvatarProps) {
  const { t } = useTranslation()
  const px = resolveSize(size)
  const extra = className ? ` ${className}` : ''
  const label = displayName ?? t('avatar.unknown')
  const { className: ringClassName, style: ringStyle } = ringFor(ring, statusVariant)
  const ringClass = ringClassName ? ` ${ringClassName}` : ''

  if (src) {
    return (
      <img
        src={src}
        alt={decorative ? '' : label}
        aria-hidden={decorative || undefined}
        style={{ width: px, height: px, ...ringStyle }}
        className={`rounded-full object-cover${ringClass}${extra}`}
      />
    )
  }

  if (fallback === 'silhouette') {
    return (
      <div
        role={decorative ? undefined : 'img'}
        aria-label={decorative ? undefined : label}
        aria-hidden={decorative || undefined}
        style={{ width: px, height: px, ...ringStyle }}
        className={`rounded-full bg-surface flex items-center justify-center overflow-hidden${ringClass}${extra}`}
      >
        <AvatarSilhouette />
      </div>
    )
  }

  return (
    <div
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : label}
      aria-hidden={decorative || undefined}
      style={{ width: px, height: px, fontSize: fontSizeFor(px), ...ringStyle }}
      className={`rounded-full bg-progress-track text-on-surface-variant flex items-center justify-center font-bold${ringClass}${extra}`}
    >
      <span aria-hidden="true">{displayName ? getInitials(displayName) : '?'}</span>
    </div>
  )
}
