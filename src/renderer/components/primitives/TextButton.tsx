// The low-emphasis action: amber label, no fill, underline on hover. It exists for the places a
// filled Button would outweigh what it does — the "Show all / Show fewer" toggles inside the
// 300px sidebar tiles, where a `px-5 py-2.5` pill would dominate the roster it reveals.
//
// `-m-1 p-1` is the focus-ring gutter convention used across the app (see the pane rule in
// design.md): the padding gives the ring room to sit off the glyphs and the equal negative margin
// takes it straight back, so the label occupies exactly the box it would with no padding at all
// and nothing around it shifts. That also means callers must right-align with `justify-end` /
// `justify-between` on the parent, never `ml-auto` on the button — `ml-auto` and `-m-1` set the
// same property, and which one wins is stylesheet order, not class order.
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
