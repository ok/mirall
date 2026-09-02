import type { Ref } from 'react'
import { useTranslation } from 'react-i18next'
import FilePath from './FilePath.js'

interface PathRowProps {
  path: string | null
  /** Shown in place of the path when there is none yet. Defaults to the pick-a-location hint. */
  placeholder?: string
  /** Overrides the label. Leave unset — the default already says the right verb for the state. */
  actionLabel?: string
  /** Omit for a display-only row — the field keeps its shape, the button is absent. */
  onAction?: () => void
  ariaDescribedBy?: string
  /** Forwarded to the button, for callers that must hand focus back to it. */
  actionRef?: Ref<HTMLButtonElement>
  /**
   * Which ramp step fills the field. The default suits a modal panel, which is
   * `surface-container-lowest`. A settings card is itself `surface-container-low` — the same
   * token, the same hex in both themes — so a row inside one passes `lowest` or the field
   * disappears into the card it sits in.
   */
  fill?: 'low' | 'lowest'
}

const FILL = {
  low: 'bg-surface-container-low',
  lowest: 'bg-surface-container-lowest',
} as const

// One filesystem path, presented the same way everywhere it appears: the path in a filled field,
// with an optional button beside it that re-picks it. Add Folder, Mirror to Disk, Edit Folder,
// Storage settings and Edit Space all show the same thing and had drifted — three shared this
// markup while two rendered a bare line of text next to a shorter, dimmer button, so the same fact
// looked like a different kind of thing depending on how you arrived at it.
//
// Display-only keeps the field rather than falling back to bare text: a path is a value either
// way, and the button's presence is what says whether you can change it.
//
// The label follows the state rather than the caller: nothing picked yet is a first pick
// ("Browse…"), a path already in the field is a re-pick ("Change"). Callers used to choose, and
// chose four different strings for the one action.
export default function PathRow({ path, placeholder, actionLabel, onAction, ariaDescribedBy, actionRef, fill = 'low' }: PathRowProps) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-3">
      <div className={`flex-grow flex items-center ${FILL[fill]} px-5 py-3.5 rounded-xl min-w-0`}>
        {path ? (
          <FilePath path={path} className="flex-1 text-sm text-accent font-medium" />
        ) : (
          <span className="text-sm text-outline/70 italic">{placeholder ?? t('pathField.placeholder')}</span>
        )}
      </div>
      {onAction && (
        <button
          ref={actionRef}
          type="button"
          onClick={onAction}
          aria-describedby={ariaDescribedBy}
          className="shrink-0 bg-surface-control text-accent rounded-xl px-5 py-3.5 font-headline font-bold text-sm hover:bg-surface-control-hover active:scale-95 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30"
        >
          {actionLabel ?? (path ? t('actions.change') : t('pathField.browse'))}
        </button>
      )}
    </div>
  )
}
