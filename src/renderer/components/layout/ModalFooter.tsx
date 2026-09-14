import type { ReactNode } from 'react'

// The row of buttons a dialog ends on.
interface ModalFooterProps {
  children: ReactNode
  // `split` gives both buttons half the width — the shape a decision takes, where neither answer is
  // the small one. `end` right-aligns them at their own width, for a step that continues rather
  // than decides.
  layout: 'split' | 'end'
  className?: string
}

const LAYOUT = {
  split: 'gap-4 [&>*]:flex-1',
  end: 'justify-end gap-3',
}

export default function ModalFooter({ children, layout, className }: ModalFooterProps) {
  return (
    <div className={`pt-2 flex ${LAYOUT[layout]}${className ? ` ${className}` : ''}`}>
      {children}
    </div>
  )
}
