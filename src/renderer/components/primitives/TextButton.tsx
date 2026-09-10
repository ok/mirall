// The low-emphasis action: amber label, no fill, underline on hover — for places a filled Button
// would outweigh what it does (the "Show all / Show fewer" toggles inside the 300px sidebar tiles).
// `-m-1 p-1` is the app's focus-ring gutter (design.md): callers right-align with `justify-end` /
// `justify-between` on the parent, never `ml-auto` here — both set margin, and stylesheet order wins.
import type { ReactNode } from 'react'

interface TextButtonProps {
  children: ReactNode
  onClick: () => void
  ariaExpanded?: boolean
  ariaLabel?: string
  className?: string
}

export default function TextButton({ children, onClick, ariaExpanded, ariaLabel, className }: TextButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={ariaExpanded}
      aria-label={ariaLabel}
      className={`-m-1 p-1 shrink-0 rounded-lg text-sm font-bold text-secondary hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30${className ? ` ${className}` : ''}`}
    >
      {children}
    </button>
  )
}
