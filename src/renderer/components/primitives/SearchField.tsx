import type { ReactNode, Ref } from 'react'
import Icon from './Icon.js'
import { FIELD_PLACEHOLDER } from './TextField.js'
import { FIELD_FILL, useFieldFill } from './FieldGround.js'

interface SearchFieldProps {
  label: string
  placeholder: string
  value: string
  onChange: (value: string) => void
  inputRef?: Ref<HTMLInputElement>
  // The compact height of the list header.
  compact?: boolean
  // Keeps the typed text clear of what the caller overlays at the right end.
  endInset?: boolean
  className?: string
  // Overlays inside the field's box, positioned by the caller.
  children?: ReactNode
}

// The search variant of the field: the glyph and the placeholder name it, so it has no visible label.
export default function SearchField({
  label, placeholder, value, onChange, inputRef, compact, endInset, className, children,
}: SearchFieldProps) {
  const fill = useFieldFill()
  return (
    <div className={`relative${className ? ` ${className}` : ''}`}>
      <span className="absolute left-4 top-1/2 -translate-y-1/2 text-on-surface-variant pointer-events-none">
        <Icon name="search" size={18} />
      </span>
      <input
        ref={inputRef}
        type="search"
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`w-full ${FIELD_FILL[fill]} border-none rounded-xl ${compact ? 'py-2.5' : 'py-4'} pl-11 ${endInset ? 'pr-28' : 'pr-4'} text-sm text-on-surface ${FIELD_PLACEHOLDER} focus-ring`}
      />
      {children}
    </div>
  )
}
