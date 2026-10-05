// One choice in a radio group, as a card: the native radio carries the role, the state and the keyboard,
// the card carries the look. The selection ring and the focus ring are drawn inside the card, so a
// scrolling list cannot clip them, and focus shows on the card rather than on the small native control.
// A card with a title and a body names the choice by the title and describes it by the body, rather
// than reading the whole card as its name.
import type { ReactNode, Ref } from 'react'

interface RadioCardProps {
  name: string
  checked: boolean
  onSelect: () => void
  inputRef?: Ref<HTMLInputElement>
  labelledBy?: string
  describedBy?: string
  children: ReactNode
}

export default function RadioCard({ name, checked, onSelect, inputRef, labelledBy, describedBy, children }: RadioCardProps) {
  return (
    <label
      className={`flex items-start gap-4 rounded-xl p-4 cursor-pointer ring-inset transition-colors bg-surface-container-low hover:bg-surface-container-high has-[:focus-visible]:bg-surface-container-high ${checked ? 'ring-2 ring-secondary' : 'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-secondary/40'}`}
    >
      <input ref={inputRef} type="radio" name={name} checked={checked} onChange={onSelect} aria-labelledby={labelledBy} aria-describedby={describedBy} className="accent-primary mt-1 shrink-0 focus:outline-none" />
      {children}
    </label>
  )
}
