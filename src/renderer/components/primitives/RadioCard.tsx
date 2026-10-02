// One choice in a radio group, as a card: the native radio carries the role, the state and the keyboard,
// the card carries the look. The selection ring and the focus ring are drawn inside the card, so a
// scrolling list cannot clip them, and focus shows on the card rather than on the small native control.
import type { ReactNode, Ref } from 'react'

interface RadioCardProps {
  name: string
  checked: boolean
  onSelect: () => void
  inputRef?: Ref<HTMLInputElement>
  children: ReactNode
}

export default function RadioCard({ name, checked, onSelect, inputRef, children }: RadioCardProps) {
  return (
    <label
      className={`flex items-start gap-4 rounded-xl p-4 cursor-pointer ring-inset transition-colors bg-surface-container-low hover:bg-surface-container-high has-[:focus-visible]:bg-surface-container-high ${checked ? 'ring-2 ring-secondary' : 'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-secondary/40'}`}
    >
      <input ref={inputRef} type="radio" name={name} checked={checked} onChange={onSelect} className="accent-primary mt-1 shrink-0 focus:outline-none" />
      {children}
    </label>
  )
}
