import { useId } from 'react'

interface ToggleProps {
  label: string
  description?: string
  checked: boolean
  disabled?: boolean
  onChange: (next: boolean) => void
}

// The full-width row form: the whole control is one button, so it cannot sit in a row
// beside other buttons. Use CompactToggle for that.
export default function Toggle({ label, description, checked, disabled, onChange }: ToggleProps) {
  const labelId = useId()
  const descId = useId()
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelId}
      aria-describedby={description ? descId : undefined}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`w-full p-6 flex items-center justify-between text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-secondary/30 ${
        disabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-surface-container-high/50'
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

interface CompactToggleProps {
  ariaLabel: string
  checked: boolean
  disabled?: boolean
  onChange: (next: boolean) => void
}

// Just the switch, named by aria-label instead of a sibling text node, so it can be one
// control among several in a row.
export function CompactToggle({ ariaLabel, checked, disabled, onChange }: CompactToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`shrink-0 rounded-full transition-opacity focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30 ${
        disabled ? 'opacity-50 cursor-not-allowed' : 'hover:opacity-90'
      }`}
    >
      <ToggleSwitch checked={checked} />
    </button>
  )
}

function ToggleSwitch({ checked }: { checked: boolean }) {
  return (
    <span
      className={`shrink-0 inline-flex items-center w-12 h-7 rounded-full p-1 transition-colors ${
        checked ? 'bg-primary' : 'bg-surface-container-high'
      }`}
      aria-hidden="true"
    >
      <span
        className={`w-5 h-5 rounded-full bg-on-primary transition-transform ${
          checked ? 'translate-x-5' : 'translate-x-0'
        }`}
      />
    </span>
  )
}
