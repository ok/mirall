import type { CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { getInitials } from '../../utils.js'

export type AvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl'
export type AvatarRing = 'none' | 'surface-container-lowest' | 'surface-container-low' | 'status'
export type AvatarStatus = 'ok' | 'connecting' | 'offline'
export type AvatarFallback = 'initials' | 'silhouette'

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
  return { className: '', style: { boxShadow: `0 0 0 2px var(--color-${ring})` } }
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
      className={`rounded-full bg-surface-container-highest text-on-surface-variant flex items-center justify-center font-bold${ringClass}${extra}`}
    >
      <span aria-hidden="true">{displayName ? getInitials(displayName) : '?'}</span>
    </div>
  )
}
