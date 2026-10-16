// A drawn box over a native checkbox. The input keeps the role, the checked state, the keyboard
// and the label; the box is paint. `mixed` sets the DOM indeterminate flag, which is what reaches
// the AX tree as a mixed state. The unchecked border is on-surface-variant: outline fails 3:1 on
// the dark rows. The change handler is backed by the click, so it carries the shift key a range
// needs, from a pointer and from the keyboard alike.
import { useLayoutEffect, useRef, type ChangeEvent } from 'react'
import Icon from './Icon.js'

export interface CheckboxProps {
  checked: boolean | 'mixed'
  /** The accessible name. Shown beside the box when `showLabel` is set; otherwise the box stands alone. */
  label: string
  onChange: (next: boolean, shift: boolean) => void
  /** md is the 40px hit area of a row control; sm the 32px of a dialog row. */
  size?: 'md' | 'sm'
  showLabel?: boolean
  title?: string
  className?: string
}

export default function Checkbox({ checked, label, onChange, size = 'md', showLabel = false, title, className }: CheckboxProps) {
  const ref = useRef<HTMLInputElement>(null)
  useLayoutEffect(() => {
    if (ref.current) ref.current.indeterminate = checked === 'mixed'
  }, [checked])
  const filled = checked !== false
  const hit = size === 'md' ? 'w-10 h-10' : 'w-8 h-8'
  function change(e: ChangeEvent<HTMLInputElement>) {
    const native = e.nativeEvent
    onChange(e.target.checked, native instanceof MouseEvent || native instanceof KeyboardEvent ? native.shiftKey : false)
  }
  const box = (
    <span
      aria-hidden="true"
      className={`w-5 h-5 rounded flex items-center justify-center transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-secondary ${filled ? 'bg-primary text-on-primary' : 'border-2 border-on-surface-variant'}`}
    >
      {checked === true && <Icon name="check" size={16} />}
      {checked === 'mixed' && <span className="block w-2.5 h-0.5 rounded-full bg-on-primary" />}
    </span>
  )
  const input = (
    <input
      ref={ref}
      type="checkbox"
      className="sr-only peer"
      aria-label={showLabel ? undefined : label}
      checked={checked === true}
      onChange={change}
    />
  )
  if (showLabel) {
    return (
      <label title={title} className={`inline-flex items-center gap-2 cursor-pointer${className ? ` ${className}` : ''}`}>
        {/* The input sits beside the box inside the hit area, so the box stays the input's peer
            and wears the focus ring in this form too. */}
        <span className={`${hit} shrink-0 flex items-center justify-center rounded-full control-hover`}>{input}{box}</span>
        <span className="text-sm text-on-surface-variant font-medium">{label}</span>
      </label>
    )
  }
  return (
    <label title={title} className={`${hit} shrink-0 flex items-center justify-center rounded-full control-hover cursor-pointer${className ? ` ${className}` : ''}`}>
      {input}
      {box}
    </label>
  )
}
