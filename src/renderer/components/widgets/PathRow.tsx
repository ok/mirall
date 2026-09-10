import type { Ref } from 'react'
import { useTranslation } from 'react-i18next'
import FilePath from './FilePath.js'

interface PathRowProps {
  path: string | null
  /**
   * A path exists but its text has not arrived yet. Distinct from having none: the field says so
   * instead of offering a first pick, and the button already reads as a re-pick, so the label does
   * not flip once the read lands.
   */
  loading?: boolean
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

// One filesystem path, presented the same way everywhere: the path in a filled field, with an
// optional button beside it that re-picks it. Display-only keeps the field — a path is a value
// either way; the button's presence says whether you can change it. The label follows the state,
// not the caller: nothing picked is "Browse…", a path (or one still loading) is "Change". The
// placeholder is muted TEXT, not `outline`: that token fails AA against every fill in both themes.
export default function PathRow({ path, loading = false, onAction, ariaDescribedBy, actionRef, fill = 'low' }: PathRowProps) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-3">
      <div className={`flex-grow flex items-center ${FILL[fill]} px-5 py-3.5 rounded-xl min-w-0`}>
        {path ? (
          <FilePath path={path} className="flex-1 text-sm text-accent font-medium" />
        ) : (
          <span className="text-sm text-on-surface-variant italic">
            {loading ? t('pathField.loading') : t('pathField.placeholder')}
          </span>
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
          {path || loading ? t('actions.change') : t('pathField.browse')}
        </button>
      )}
    </div>
  )
}
