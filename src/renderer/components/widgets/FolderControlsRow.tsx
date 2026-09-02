// The listing's own controls, pinned directly above the first file row and outside the scroll pane.
// It never moves and never disappears — a strip appearing above it must not take the filter with
// it, which is also what keeps focus alive when a scan starts under the user's hands.
import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import Icon from '../primitives/Icon.js'
import Button from '../primitives/Button.js'

interface FolderControlsRowProps {
  value: string
  onChange: (value: string) => void
  matched: number | null
  total: number
  expandLabel: string
  onToggleExpand: () => void
  showExpand: boolean
}

export default function FolderControlsRow({
  value,
  onChange,
  matched,
  total,
  expandLabel,
  onToggleExpand,
  showExpand,
}: FolderControlsRowProps) {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)
  const filtering = value.trim().length > 0

  function clear() {
    onChange('')
    inputRef.current?.focus()
  }

  return (
    <div className="flex items-center gap-3 mb-3 shrink-0">
      <div className="relative flex-1 min-w-0">
        <span className="absolute left-4 top-1/2 -translate-y-1/2 text-outline pointer-events-none">
          <Icon name="search" size={18} />
        </span>
        <input
          ref={inputRef}
          type="search"
          aria-label={t('folder.filterLabel')}
          placeholder={t('folder.filterPlaceholder')}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={`w-full bg-surface-container-lowest dark:bg-surface-container-low border-none rounded-xl pl-11 py-2.5 text-sm text-on-surface placeholder:text-on-surface-variant/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30 ${filtering ? 'pr-28' : 'pr-4'}`}
        />
        {/* The count rides inside the field so the row keeps exactly two controls at every width.
            Announced from its own polite region rather than the rows, which would re-read the
            whole listing on every keystroke. */}
        <span
          role="status"
          aria-live="polite"
          className={filtering ? 'absolute right-11 top-1/2 -translate-y-1/2 text-xs text-on-surface-variant pointer-events-none tabular-nums' : 'sr-only'}
        >
          {filtering && matched !== null ? t('folder.filterCount', { shown: matched, total }) : ''}
        </span>
        {filtering && (
          <button
            type="button"
            onClick={clear}
            aria-label={t('folder.filterClear')}
            title={t('folder.filterClear')}
            className="absolute right-2 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full hover:bg-surface-container-high flex items-center justify-center text-on-surface-variant focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30"
          >
            <Icon name="close" size={14} />
          </button>
        )}
      </div>
      {showExpand && (
        <Button variant="secondary" onClick={onToggleExpand} className="shrink-0">
          {expandLabel}
        </Button>
      )}
    </div>
  )
}
