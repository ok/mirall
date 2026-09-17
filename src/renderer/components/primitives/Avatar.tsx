// Peer/space avatar: an image when there is one, initials otherwise.
//
// The initials disc is a fill on whatever hosts it, and its hosts lift on hover, so it takes the
// hover-proof neutral rather than a ramp token one of them can adopt out from under it — the same
// reason the +N disc does (see the token note in design.md). Every shape is recessed; see below.
//
// `decorative` means a label sits next to it, so the avatar leaves the accessibility tree rather
// than reading the name twice. `ring='status'` requires a statusVariant — the ring IS the status,
// and without one it renders the neutral ring and says nothing.
import type { CSSProperties, ReactNode } from 'react'
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

interface DiscProps {
  // The box every shape paints into: size + the ring, which is a shadow rather than a border and so
  // never moves the disc.
  style: CSSProperties
  // The recess, the ring's own class and the caller's, already joined.
  className: string
  label: string
  decorative?: boolean
}

// A disc that is not an image: initials or the silhouette, both named by their role rather than
// their contents.
function FilledDisc({ style, className, label, decorative, fill, children }: DiscProps & { fill: string; children: ReactNode }) {
  return (
    <div
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : label}
      aria-hidden={decorative || undefined}
      style={style}
      className={`rounded-full ${fill} flex items-center justify-center overflow-hidden ${className}`}
    >
      {children}
    </div>
  )
}

// An <img> hosts no ::after, so it is wrapped and the wrapper takes the box, the ring and the
// caller's className — what every other shape puts on the disc itself.
function ImageDisc({ src, style, className, label, decorative }: DiscProps & { src: string }) {
  return (
    <span style={style} className={`block rounded-full ${className}`}>
      <img
        src={src}
        alt={decorative ? '' : label}
        aria-hidden={decorative || undefined}
        className="w-full h-full rounded-full object-cover"
      />
    </span>
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
  const label = displayName ?? t('avatar.unknown')
  const { className: ringClassName, style: ringStyle } = ringFor(ring, statusVariant)
  // Every avatar is set INTO its surface rather than laid on top of one, so the recess is part of
  // the disc and not of any one ring: a surface ring is the hole it sits in, a status ring is a
  // signal painted around it, `none` is a host that draws neither — the lip is the same in all
  // three, which is what makes a face look like the same object on every screen.
  const disc: DiscProps = {
    style: { width: px, height: px, ...ringStyle },
    className: ['avatar-recess', ringClassName, className].filter(Boolean).join(' '),
    label,
    decorative,
  }

  if (src) return <ImageDisc {...disc} src={src} />

  if (fallback === 'silhouette') {
    return <FilledDisc {...disc} fill="bg-surface"><AvatarSilhouette /></FilledDisc>
  }

  return (
    <FilledDisc {...disc} fill="bg-progress-track">
      <span aria-hidden="true" className="text-on-surface-variant font-bold" style={{ fontSize: fontSizeFor(px) }}>
        {displayName ? getInitials(displayName) : '?'}
      </span>
    </FilledDisc>
  )
}
