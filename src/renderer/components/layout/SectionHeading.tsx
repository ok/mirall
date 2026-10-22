import type { ReactNode } from 'react'

interface SectionHeadingProps {
  children: ReactNode
  /** For a control the heading names through `aria-labelledby`. */
  id?: string
}

export default function SectionHeading({ children, id }: SectionHeadingProps) {
  return (
    <h2 id={id} className="text-xl font-headline font-bold text-accent mb-6">{children}</h2>
  )
}
