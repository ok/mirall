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

// Per-variant color / elevation / focus-ring / hover; layout is shared in `base` below.
// Hover never blends (`opacity-90` mixes the page in): each hover token is the resting fill stepped
// AWAY from the page — darker in light mode, lighter in dark — except the two brand fills at the
// end of the ramp, which step inward. design.md carries the table; control-hover-tokens.test.js pins it.
// `secondary` is the neutral surface style (cancel / dismiss; shared with the top-nav feedback
// button and the filter chips). `danger` is the tonal destructive style for every destructive
// action, in-page or in a modal: it rests in the soft error-container fill and hovers to a deeper
// shade of the same red rather than jumping to a neutral color.
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
