// The listing's own controls, pinned directly above the first row and outside the scroll pane.
// It never moves and never disappears — a strip appearing above it must not take the filter with
// it, which is also what keeps focus alive when a scan starts under the user's hands. The top box,
// when offered, heads the selection column: its first tick opens the column with every matching
// file selected, after that it is an ordinary select-all.
import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import Icon from '../primitives/Icon.js'
import SearchField from '../primitives/SearchField.js'
import Button from '../primitives/Button.js'
import Checkbox from '../primitives/Checkbox.js'
import type { TriState } from '../../model/batch-selection.js'

export interface SelectAllBox {
  state: TriState
  label: string
  onToggle: () => void
}

interface ListControlsRowProps {
  value: string
  onChange: (value: string) => void
  matched: number | null
  total: number
  filterLabel: string
  selectAll?: SelectAllBox | null
  expandLabel?: string
  onToggleExpand?: () => void
  showExpand: boolean
}

export default function ListControlsRow({
  value,
  onChange,
  matched,
  total,
  filterLabel,
  selectAll,
  expandLabel,
  onToggleExpand,
  showExpand,
}: ListControlsRowProps) {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)
  const filtering = value.trim().length > 0

  function clear() {
    onChange('')
    inputRef.current?.focus()
  }

  return (
    <div className="flex items-center gap-3 mb-3 shrink-0">
      {selectAll && (
        <Checkbox
          checked={selectAll.state === 'on' ? true : selectAll.state === 'mixed' ? 'mixed' : false}
          label={selectAll.label}
          title={selectAll.label}
          onChange={selectAll.onToggle}
        />
      )}
      <SearchField
        inputRef={inputRef}
        label={filterLabel}
        placeholder={t('folder.filterPlaceholder')}
        value={value}
        onChange={onChange}
        compact
        endInset={filtering}
        className="flex-1 min-w-0"
      >
        {/* The count rides inside the field so the row's controls never wrap. Announced from its
            own polite region rather than the rows, which would re-read the whole listing on every
            keystroke. */}
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
            className="absolute right-2 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full hover:bg-surface-container-high flex items-center justify-center text-on-surface-variant focus-ring"
          >
            <Icon name="close" size={14} />
          </button>
        )}
      </SearchField>
      {showExpand && onToggleExpand && (
        <Button variant="secondary" onClick={onToggleExpand} className="shrink-0">
          {expandLabel}
        </Button>
      )}
    </div>
  )
}
