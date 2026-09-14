import type { ReactNode } from 'react'

// The error sentence that sits under the thing that failed. `role="alert"` is the point of it: the
// message is announced when it appears, which a plain red paragraph is not.
//
// `id` is not decoration — a field that failed points `aria-describedby` at it, which is what ties
// the message to the control for a screen reader returning to it later.
interface InlineErrorProps {
  children: ReactNode
  // `sm` under a field or a section; `xs` in a dense row where the message sits beside metadata.
  size?: 'sm' | 'xs'
  // Per-site spacing only. Tone and role are the component's.
  className?: string
  id?: string
}

// Spelled out rather than interpolated: Tailwind scans source for whole class names, and a
// `text-${size}` would be invisible to it.
const SIZE = { sm: 'text-sm', xs: 'text-xs' }

export default function InlineError({ children, size = 'sm', className, id }: InlineErrorProps) {
  return (
    <p id={id} role="alert" className={`${SIZE[size]} text-error${className ? ` ${className}` : ''}`}>
      {children}
    </p>
  )
}
