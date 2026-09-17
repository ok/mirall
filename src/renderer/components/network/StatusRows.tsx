// The row primitives every Network Status section renders through: a titled surface, a labelled
// value with an optional copy control, and a masked value with reveal + copy.
import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import CopyButton from '../primitives/CopyButton.js'
import { DASH, maskValue } from '../../format/status-values.js'
import Icon from '../primitives/Icon.js'

// A revealed key re-masks itself: the value is shoulder-surfable and the screen is one a user
// leaves open while working through a connectivity problem.
const REVEAL_AUTO_HIDE_MS = 30000

export function Section({ title, intro = null, children }: { title: string; intro?: string | null; children: ReactNode }) {
  return (
    <section>
      <h2 className="text-xl font-headline font-bold text-accent mb-4">{title}</h2>
      {intro && <p className="text-sm text-on-surface-variant leading-relaxed mb-4">{intro}</p>}
      <div className="bg-surface-container-low rounded-xl divide-y divide-surface-container-high/30">
        {children}
      </div>
    </section>
  )
}

interface FieldProps {
  label: string
  value: ReactNode
  mono?: boolean
  copyValue?: string | null
  positive?: boolean
}

export function Field({ label, value, mono = false, copyValue = null, positive = false }: FieldProps) {
  const display = value === '' || value === undefined || value === null ? DASH : value
  return (
    <div className="px-6 py-4 flex items-center gap-4">
      <span className="text-sm text-on-surface-variant w-48 shrink-0">{label}</span>
      <span className={`flex-1 min-w-0 break-all ${mono ? 'font-mono text-sm' : 'text-sm'} ${positive ? 'text-online' : 'text-accent'}`}>
        {display}
      </span>
      {copyValue && copyValue.length > 0 && (
        <CopyButton value={copyValue} />
      )}
    </div>
  )
}

interface MaskedFieldProps {
  label: string
  value: string | null
  visibleSuffix?: number
  trailing?: ReactNode
}

export function MaskedField({ label, value, visibleSuffix = 0, trailing = null }: MaskedFieldProps) {
  const { t } = useTranslation()
  const [revealed, setRevealed] = useState(false)
  const hasValue = !!value && value.length > 0

  useEffect(() => {
    if (!revealed) return
    const timer = setTimeout(() => setRevealed(false), REVEAL_AUTO_HIDE_MS)
    return () => clearTimeout(timer)
  }, [revealed])

  const display = revealed && value ? value : maskValue(value, visibleSuffix)
  const toggleLabel = revealed ? t('networkStatus.hide') : t('networkStatus.reveal')

  return (
    <div className="px-6 py-4 flex items-center gap-4">
      <span className="text-sm text-on-surface-variant w-48 shrink-0">{label}</span>
      <span className="flex-1 min-w-0 font-mono text-sm text-accent break-all">{display}</span>
      {trailing}
      {hasValue && <CopyButton value={value} />}
      {hasValue && (
        <button
          type="button"
          onClick={() => setRevealed((v) => !v)}
          aria-label={toggleLabel}
          title={toggleLabel}
          className="shrink-0 inline-flex items-center justify-center rounded-sm focus-ring"
        >
          <Icon name={revealed ? 'visibility_off' : 'visibility'} size={18} className="text-outline" />
        </button>
      )}
    </div>
  )
}
