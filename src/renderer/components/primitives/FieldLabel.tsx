import type { ReactNode } from 'react'

// The heading above a field. Which element it renders is the whole point: a label that names a form
// control must be a <label htmlFor>, and one that names something that is not a form control — an
// icon picker, a path row whose action is a button — must not be, or the association is a lie the
// screen reader reads out. Passing `htmlFor` picks the first, `id` the second.
interface FieldLabelProps {
  children: ReactNode
  // The id of the form control this names.
  htmlFor?: string
  // The id this label carries, for a control that points `aria-labelledby` at it.
  id?: string
  className?: string
}

const BASE = 'font-headline text-sm font-bold text-accent px-1'

export default function FieldLabel({ children, htmlFor, id, className }: FieldLabelProps) {
  const cls = `${BASE}${className ? ` ${className}` : ''}`
  if (htmlFor) return <label htmlFor={htmlFor} className={cls}>{children}</label>
  return <span id={id} className={`block ${cls}`}>{children}</span>
}
