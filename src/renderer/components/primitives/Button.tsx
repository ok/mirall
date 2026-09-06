import type { MouseEvent, ReactNode, Ref } from 'react'
import Icon, { type IconName } from './Icon.js'

type ButtonVariant = 'primary' | 'secondary' | 'danger'

interface ButtonProps {
  children: ReactNode
  icon?: IconName
  iconFilled?: boolean
  size?: 'sm' | 'lg'
  variant?: ButtonVariant
  fullWidth?: boolean
  disabled?: boolean
  // Claims initial focus inside a dialog. React focuses it at commit, before react-aria's own
  // fallback runs, so the dialog leaves it alone — that is how a destructive confirm rests on Cancel.
  autoFocus?: boolean
  type?: 'button' | 'submit'
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void
  className?: string
  ariaLabel?: string
  ariaDescribedBy?: string
  ref?: Ref<HTMLButtonElement>
}

// Per-variant color / elevation / focus-ring / hover. Layout is shared in `base` below.
//
// Every variant names its hover colour; none of them blends. `hover:opacity-90` looked like a
// darkening but is really "mix 10% of whatever is behind me", so it darkened the orange in dark
// mode and LIGHTENED the plum in light mode (+9.3 L*), while the neutral swapped tokens and dropped
// to within 2.8 L* of the page it sits on — a button dissolving into its own background. Each hover
// token is instead the resting fill stepped AWAY from the page: darker in light mode, lighter in
// dark. That is the same gesture the rows, cards and menu items already make, and because it moves
// a fill toward its own label in only one theme, no variant has to spend AA headroom to be felt.
// How far is a function of how far the fill sits from the page — ~5 L* near it, ~7-9 for the brand
// fills out at the ends, where the eye (adapted to the page) stops resolving small steps. Those two
// also invert the direction, because at the end of a ramp outward has nothing left: the light plum
// rests near-black and LIGHTENS, the dark orange sits at the sRGB edge and DARKENS.
// design.md carries the table; the invariants are pinned by test/unit/control-hover-tokens.test.js.
// `secondary` is the neutral surface style shared with the top-nav "Send feedback" button and
// the filter chips, used for cancel / dismiss actions.
// `danger` is the tonal destructive style used for every destructive action (in-page
// triggers and modal confirmations alike): it rests in the soft error-container fill and
// hovers to a deeper shade of the same red rather than jumping to a neutral color.
const variantClasses: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-on-primary shadow-lg shadow-primary/10 hover:bg-primary-hover focus-visible:ring-secondary/30',
  secondary: 'bg-surface-control text-on-surface-variant hover:bg-surface-control-hover focus-visible:ring-secondary/30',
  danger: 'bg-error-container text-on-error-container hover:bg-error-container-hover focus-visible:ring-error/30',
}

export default function Button({
  children,
  icon,
  iconFilled,
  size = 'sm',
  variant = 'primary',
  fullWidth,
  disabled,
  autoFocus,
  type = 'button',
  onClick,
  className,
  ariaLabel,
  ariaDescribedBy,
  ref,
}: ButtonProps) {
  const base = 'flex items-center justify-center gap-2 whitespace-nowrap rounded-xl font-headline font-bold transition-all active:scale-95 focus:outline-none focus-visible:ring-2 disabled:opacity-50 disabled:cursor-not-allowed'
  const sizeClasses = size === 'lg' ? 'h-14 px-5 text-lg' : 'px-5 py-2.5 text-sm'
  const widthClass = fullWidth ? ' w-full' : ''
  const extra = className ? ` ${className}` : ''
  return (
    <button
      ref={ref}
      type={type}
      onClick={onClick}
      disabled={disabled}
      autoFocus={autoFocus}
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      className={`${base} ${variantClasses[variant]} ${sizeClasses}${widthClass}${extra}`}
    >
      {icon && <Icon name={icon} filled={iconFilled} size={20} />}
      {children}
    </button>
  )
}
