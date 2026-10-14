// A bare icon control: circular hit area, no background until hover, and `ariaLabel` REQUIRED —
// there is no text to name it, so the type makes the accessible name non-optional.
//
// The icon paints iconClassName (`text-accent` unless given). A destructive control is
// `variant="danger"`: its ink sits on the button and the icon drops its own, so the hover's
// `on-error-container` reaches the icon (`error` on `error-container` fails the 3:1 floor in dark).
import type { MouseEvent } from 'react'
import Icon from './Icon.js'
import type { IconName } from '../../types/ui.js'

interface IconButtonProps {
  icon: IconName
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void
  ariaLabel: string
  title?: string
  type?: 'button' | 'submit'
  disabled?: boolean
  iconClassName?: string
  iconSize?: number
  iconFilled?: boolean
  className?: string
  variant?: 'default' | 'danger'
}

const HOVER = {
  default: 'control-hover',
  danger: 'text-error hover:bg-error-container hover:text-on-error-container',
} as const

const withoutInk = (classes: string) => classes.split(/\s+/).filter((c) => c && !c.startsWith('text-')).join(' ') || undefined

export default function IconButton({
  icon,
  onClick,
  ariaLabel,
  title,
  type = 'button',
  disabled,
  iconClassName = 'text-accent',
  iconSize,
  iconFilled,
  className,
  variant = 'default',
}: IconButtonProps) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      title={title}
      className={`w-10 h-10 shrink-0 flex items-center justify-center rounded-full ${HOVER[variant]} active:scale-95 transition-all focus-ring disabled:opacity-40 disabled:cursor-not-allowed${className ? ` ${className}` : ''}`}
    >
      <Icon name={icon} size={iconSize} filled={iconFilled} className={variant === 'danger' ? withoutInk(iconClassName) : iconClassName} />
    </button>
  )
}
