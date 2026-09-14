import Avatar from './Avatar.js'

type StackSurface = 'surface-container-lowest' | 'surface-container-low'

interface StackedAvatar {
  key: string
  src?: string | null
  displayName?: string | null
  title?: string
  // Per-avatar state — the mirror-state ring, the dim on a paused peer.
  className?: string
}

// How the strip is announced. `hidden` where the control around it already says who is in it;
// `group` where the strip is one thing with one name; `each` where every face is its own name and
// the +N chip carries the rest. Three call sites, three answers — so it is a choice, not a default.
type Announce = 'hidden' | 'group' | 'each'

interface AvatarStackProps {
  avatars: StackedAvatar[]
  overflow: number
  size: 'sm' | 'md' | 'lg' | 'xl'
  // The surface the strip sits on. The rings are cut from it, so the discs read as separate against
  // it — one token, not a class name and a CSS variable spelled out apart from each other.
  surface: StackSurface
  announce: Announce
  // Names the strip under `group`, and the +N chip under `each`.
  label?: string
  // Set when the avatars carry their own ring through `className`.
  ringless?: boolean
  className?: string
}

// The +N disc is the same disc as an avatar of that size, so its box tracks Avatar's SIZE_PX.
const CHIP = {
  sm: 'w-8 h-8 text-xs',
  md: 'w-9 h-9 text-sm',
  lg: 'w-12 h-12 text-sm',
  xl: 'w-20 h-20 text-base',
}

export default function AvatarStack({
  avatars, overflow, size, surface, announce, label, ringless, className,
}: AvatarStackProps) {
  const ringStyle = { boxShadow: `0 0 0 2px var(--color-${surface})` }
  return (
    <div
      role={announce === 'group' ? 'img' : undefined}
      aria-label={announce === 'group' ? label : undefined}
      aria-hidden={announce === 'hidden' || undefined}
      className={`flex items-center -space-x-3${className ? ` ${className}` : ''}`}
    >
      {avatars.map((a) => (
        <span key={a.key} title={a.title}>
          <Avatar
            src={a.src}
            displayName={a.displayName}
            size={size}
            ring={ringless ? 'none' : surface}
            className={a.className}
            decorative={announce !== 'each'}
          />
        </span>
      ))}
      {overflow > 0 && (
        <div
          role={announce === 'each' ? 'img' : undefined}
          aria-label={announce === 'each' ? label : undefined}
          style={ringStyle}
          className={`${CHIP[size]} rounded-full bg-surface-container-highest text-on-surface-variant flex items-center justify-center font-bold`}
        >
          <span aria-hidden="true">+{overflow}</span>
        </div>
      )}
    </div>
  )
}
