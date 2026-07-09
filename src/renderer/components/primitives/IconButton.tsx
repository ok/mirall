import type { MouseEvent } from 'react'
import Icon, { type IconName } from './Icon.js'

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
}

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
}: IconButtonProps) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      title={title}
      className={`w-10 h-10 shrink-0 flex items-center justify-center rounded-full hover:bg-surface-container-high active:scale-95 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30 disabled:opacity-40 disabled:cursor-not-allowed${className ? ` ${className}` : ''}`}
    >
      <Icon name={icon} size={iconSize} filled={iconFilled} className={iconClassName} />
    </button>
  )
}
