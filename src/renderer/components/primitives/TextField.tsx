import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import FieldLabel from './FieldLabel.js'
import InlineError from './InlineError.js'

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
}

// The field surface. Exported because a <textarea> is the same box with a height — one string, so
// the two cannot drift apart.
export const FIELD_SURFACE = 'w-full bg-surface-container-low border-none focus-ring rounded-xl px-6 py-4 text-accent font-medium placeholder:text-outline/50 transition-all'

export default function TextField({
  id, label, value, onChange, error, help, invalid, describedBy, mono, disabled, ...input
}: TextFieldProps) {
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
        className={`${FIELD_SURFACE}${mono ? ' font-mono text-sm' : ''}${disabled ? ' disabled:opacity-60' : ''}`}
      />
      {help && <p id={helpId} className="text-xs text-on-surface-variant px-1">{help}</p>}
      {error && <InlineError id={errorId} size="xs" className="px-1">{error}</InlineError>}
    </div>
  )
}
