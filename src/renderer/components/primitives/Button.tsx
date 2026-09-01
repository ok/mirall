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
  type?: 'button' | 'submit'
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void
  className?: string
  ariaLabel?: string
  ariaDescribedBy?: string
  ref?: Ref<HTMLButtonElement>
}

// Per-variant color / elevation / focus-ring / hover. Layout is shared in `base` below.
// `secondary` is the neutral surface style shared with the top-nav "Send feedback" button and
// the filter chips, used for cancel / dismiss actions.
// `danger` is the tonal destructive style used for every destructive action (in-page
// triggers and modal confirmations alike): it rests in the soft error-container fill and
// hovers to a slightly shifted shade of the same red rather than jumping to a neutral color.
const variantClasses: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-on-primary shadow-lg shadow-primary/10 hover:opacity-90 focus-visible:ring-secondary/30',
  secondary: 'bg-surface-container-high dark:bg-surface-container-highest text-on-surface-variant hover:bg-surface-container-highest dark:hover:bg-surface-container-high focus-visible:ring-secondary/30',
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
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      className={`${base} ${variantClasses[variant]} ${sizeClasses}${widthClass}${extra}`}
    >
      {icon && <Icon name={icon} filled={iconFilled} size={20} />}
      {children}
    </button>
  )
}
