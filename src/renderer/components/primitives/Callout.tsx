import type { ReactNode } from 'react'
import Icon from './Icon.js'
import type { IconName } from '../../types/ui.js'

// A boxed sentence inside content that the reader should not skim past. Two tones, chosen by what
// the text says, not by how loud it should look:
// - `note`: context or a caution about an action the reader is about to take. It sits on the
//   input-field gray, so it stands out from the panel without claiming that anything is wrong.
// - `warning`: a condition that holds right now and limits what the reader can do. Only this tone
//   is amber.
// The icon is decorative; the words carry the kind, never the colour alone.
interface CalloutProps {
  tone: 'note' | 'warning'
  children: ReactNode
  // Defaults to `info` for a note and `warning` for a warning.
  icon?: IconName
  title?: ReactNode
  // `status` only when the callout appears in response to the reader's input.
  role?: 'status'
  // A field the callout explains points `aria-describedby` here.
  id?: string
  // Per-site spacing only. Tone and geometry are the component's.
  className?: string
}

const TONE = {
  note: { box: 'bg-surface-container-low', icon: 'text-secondary', title: 'text-on-surface', body: 'text-on-surface-variant', defaultIcon: 'info' },
  warning: { box: 'bg-warning-container', icon: 'text-on-warning-container', title: 'text-on-warning-container', body: 'text-on-warning-container', defaultIcon: 'warning' },
} as const

export default function Callout({ tone, children, icon, title, role, id, className }: CalloutProps) {
  const t = TONE[tone]
  return (
    <div id={id} role={role} className={`${t.box} rounded-xl p-4 flex items-start gap-3${className ? ` ${className}` : ''}`}>
      <Icon name={icon ?? t.defaultIcon} size={20} className={`${t.icon} shrink-0 mt-0.5`} />
      <div className="min-w-0">
        {title && <p className={`font-bold ${t.title}`}>{title}</p>}
        <div className={`text-sm leading-relaxed ${t.body}${title ? ' mt-1' : ''}`}>{children}</div>
      </div>
    </div>
  )
}
