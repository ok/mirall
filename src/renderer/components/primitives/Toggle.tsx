import { useId } from 'react'
import type { Lockable } from '../../types/ui.js'

interface ToggleProps extends Lockable {
  label: string
  description?: string
  checked: boolean
  disabled?: boolean
  onChange: (next: boolean) => void
}

// The full-width row form: the whole control is one button, so it cannot sit in a row
// beside other buttons.
export default function Toggle({ label, description, checked, disabled, locked, describedBy, onChange }: ToggleProps) {
  const labelId = useId()
  const descId = useId()
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelId}
      aria-describedby={[description ? descId : null, describedBy].filter(Boolean).join(' ') || undefined}
      aria-disabled={locked || undefined}
      disabled={disabled}
      onClick={locked ? undefined : () => onChange(!checked)}
      className={`w-full p-6 flex items-center justify-between text-left transition-colors row-focus ${
        disabled || locked ? 'opacity-50 cursor-not-allowed' : 'hover:bg-surface-container-high/50'
      }`}
    >
      <div className="pr-6">
        <p id={labelId} className="font-semibold text-accent">{label}</p>
        {description && <p id={descId} className="text-sm text-on-surface-variant mt-1">{description}</p>}
      </div>
      <ToggleSwitch checked={checked} />
    </button>
  )
}

// The switch itself. Exported for the one control that cannot be a full-width row: the Activity Log
// recording switch keeps focus while its write is in flight, which a disabled row button cannot.
// Off is drawn by an outline and a knob in on-surface-variant, not by a fill: the fill would have to
// clear 3:1 against the card, and no surface tier does.
export function ToggleSwitch({ checked }: { checked: boolean }) {
  return (
    <span
      className={`shrink-0 inline-flex items-center w-12 h-7 rounded-full p-1 border-2 transition-colors ${
        checked ? 'bg-primary border-primary' : 'border-on-surface-variant'
      }`}
      aria-hidden="true"
    >
      <span
        className={`w-4 h-4 rounded-full transition-transform ${
          checked ? 'bg-on-primary translate-x-5' : 'bg-on-surface-variant translate-x-0'
        }`}
      />
    </span>
  )
}
