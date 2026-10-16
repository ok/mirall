import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import FieldLabel from './FieldLabel.js'
import InlineError from './InlineError.js'
import { FIELD_FILL, useFieldFill, type FieldFill } from './FieldGround.js'

type OwnedByField = 'id' | 'className' | 'value' | 'onChange' | 'aria-invalid' | 'aria-describedby'

interface TextFieldProps extends Omit<ComponentPropsWithoutRef<'input'>, OwnedByField> {
  id: string
  label: ReactNode
  value: string
  onChange: (value: string) => void
  // Renders under the field and marks the control invalid. Its id is `${id}-error`, which is what
  // the field's own `aria-describedby` points at.
  error?: string | null
  // The standing note under the field — a length rule, who owns the value. Its id is `${id}-help`,
  // and it stays put when an error appears: the two say different things.
  help?: ReactNode
  // For a field whose failure is reported somewhere else on the form — pair it with `describedBy`
  // pointing at that message.
  invalid?: boolean
  describedBy?: string
  mono?: boolean
  // Even-width digits, for a number that is edited in place.
  tabular?: boolean
}

// The placeholder of every text field. Muted text, not a border token: on-surface-variant at 85%
// clears 4.5:1 on every field fill in both themes, and stays lighter than a typed value.
export const FIELD_PLACEHOLDER = 'placeholder:text-on-surface-variant/85'

// The field box. Exported because a <textarea> and the palette's combobox are the same box.
export function fieldSurface(fill: FieldFill): string {
  return `w-full ${FIELD_FILL[fill]} border-none focus-ring rounded-xl px-6 py-4 text-accent font-medium ${FIELD_PLACEHOLDER} transition-all`
}

export default function TextField({
  id, label, value, onChange, error, help, invalid, describedBy, mono, tabular, disabled, ...input
}: TextFieldProps) {
  const fill = useFieldFill()
  const helpId = help ? `${id}-help` : undefined
  const errorId = error ? `${id}-error` : undefined
  const describers = [helpId, errorId, describedBy].filter(Boolean).join(' ')
  return (
    <div className="space-y-3">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <input
        {...input}
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error || invalid ? true : undefined}
        aria-describedby={describers || undefined}
        className={`${fieldSurface(fill)}${mono ? ' font-mono text-sm' : ''}${tabular ? ' tabular-nums' : ''}${disabled ? ' disabled:opacity-60' : ''}`}
      />
      {help && <p id={helpId} className="text-xs text-on-surface-variant px-1">{help}</p>}
      {error && <InlineError id={errorId} size="xs" className="px-1">{error}</InlineError>}
    </div>
  )
}
