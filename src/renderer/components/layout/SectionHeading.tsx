import type { ReactNode } from 'react'

interface SectionHeadingProps {
  children: ReactNode
}

export default function SectionHeading({ children }: SectionHeadingProps) {
  return (
    <h2 className="text-xl font-headline font-bold text-accent mb-6">{children}</h2>
  )
}
