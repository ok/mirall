import type { ReactNode } from 'react'

// The row of buttons a dialog ends on: large buttons sharing the row equally, the secondary answer
// first and the primary last. A single button fills the row.
interface ModalFooterProps {
  children: ReactNode
  className?: string
}

const LAYOUT = 'pt-2 flex gap-4 [&>*]:flex-1'

export default function ModalFooter({ children, className }: ModalFooterProps) {
  return (
    <div className={className ? `${LAYOUT} ${className}` : LAYOUT}>
      {children}
    </div>
  )
}
