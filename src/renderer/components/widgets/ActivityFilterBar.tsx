import { useTranslation } from 'react-i18next'
import Icon from '../primitives/Icon.js'
import SegmentedControl, { Segment } from '../primitives/SegmentedControl.js'
import ActionMenu, { type ActionMenuItemConfig } from './ActionMenu.js'
import { AUDIT_CATEGORIES } from '../../hooks/useAuditLog.js'
import type { RefObject } from 'react'
import type { useActivityFilters } from '../../hooks/useActivityFilters.js'

const DAY_RANGES = [7, 30, 90]

// ActionMenu items are actions, not a selection model, so a single-choice filter marks the
// current value with a check and leaves the others blank. The trigger label carries the value
// visually and the trigger's aria-label carries it for assistive tech.
function selectItems(
  options: Array<{ id: string; label: string }>,
  selected: string,
  onSelect: (id: string) => void,
): ActionMenuItemConfig[] {
  return options.map((option) => ({
    id: option.id || '__all__',
    label: option.label,
    icon: option.id === selected ? 'check' : undefined,
    onAction: () => onSelect(option.id),
  }))
}

function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  const { t } = useTranslation()
  return (
    <span className="inline-flex items-center gap-1.5 bg-surface-container-high dark:bg-surface-container-highest text-accent rounded-full pl-4 pr-2 py-1.5 text-sm font-medium">
      {label}
      <button
        type="button"
        onClick={onRemove}
        aria-label={t('activityLog.removeFilter', { filter: label })}
        className="w-5 h-5 rounded-full flex items-center justify-center hover:bg-surface-container-highest dark:hover:bg-surface-container-high focus-ring"
      >
        <Icon name="close" size={12} />
      </button>
    </span>
  )
}

// Every prop is what useActivityFilters returns, so the bar cannot drift from the state it edits.
type Filters = ReturnType<typeof useActivityFilters>

type ActivityFilterBarProps = Pick<Filters,
  'filters' | 'setFilters' | 'active' | 'toggleCategory' | 'clearAll' | 'spaces' | 'actors'
  | 'spaceName' | 'actorName' | 'rangeLabel'
> & { searchRef: RefObject<HTMLInputElement | null> }

/**
 * The activity log's filter panel: a search field, three single-choice menus, the category
 * segments, and the chips that show what is currently narrowing the list.
 *
 * The chips are the only place a filter can be removed one at a time — the menus set a value and
 * the segments toggle, so without them "clear all" would be the only way back out of a narrow view.
 */
export default function ActivityFilterBar(props: ActivityFilterBarProps) {
  const { t } = useTranslation()
  const { filters, setFilters, active, toggleCategory, clearAll, spaces, actors, spaceName, actorName, rangeLabel, searchRef } = props
  return (
    <section>
      <div className="bg-surface-container-low rounded-xl p-6 space-y-4">
        <div className="relative">
          <span className="absolute left-4 top-1/2 -translate-y-1/2 text-outline pointer-events-none">
            <Icon name="search" size={18} />
          </span>
          <input
            ref={searchRef}
            type="search"
            aria-label={t('activityLog.searchLabel')}
            placeholder={t('activityLog.searchPlaceholder')}
            value={filters.search}
            onChange={(e) => setFilters((prev) => ({ ...prev, search: e.target.value }))}
            className="w-full bg-surface-container-lowest border-none rounded-xl pl-11 pr-4 py-4 text-sm text-on-surface placeholder:text-on-surface-variant/70 focus-ring"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <ActionMenu
            label={spaceName ?? t('activityLog.allSpaces')}
            triggerVariant="neutral"
            ariaLabel={t('activityLog.spaceFilterValue', { value: spaceName ?? t('activityLog.allSpaces') })}
            items={selectItems(
              [{ id: '', label: t('activityLog.allSpaces') }, ...spaces.map((s) => ({ id: s.id, label: s.name ?? s.id }))],
              filters.spaceId ?? '',
              (id) => setFilters((prev) => ({ ...prev, spaceId: id || null })),
            )}
          />
          <ActionMenu
            label={actorName ?? t('activityLog.anyone')}
            triggerVariant="neutral"
            ariaLabel={t('activityLog.actorFilterValue', { value: actorName ?? t('activityLog.anyone') })}
            items={selectItems(
              [{ id: '', label: t('activityLog.anyone') }, ...actors.map((a) => ({ id: a.key, label: a.name ?? a.key.slice(0, 12) }))],
              filters.actorKey ?? '',
              (id) => setFilters((prev) => ({ ...prev, actorKey: id || null })),
            )}
          />
          <ActionMenu
            label={rangeLabel}
            triggerVariant="neutral"
            ariaLabel={t('activityLog.rangeFilterValue', { value: rangeLabel })}
            items={selectItems(
              [{ id: '', label: t('activityLog.anyTime') }, ...DAY_RANGES.map((days) => ({ id: String(days), label: t('activityLog.lastNDays', { count: days }) }))],
              filters.sinceDays === null ? '' : String(filters.sinceDays),
              (id) => setFilters((prev) => ({ ...prev, sinceDays: id ? Number(id) : null })),
            )}
          />
        </div>

        <SegmentedControl wrap>
          <Segment
            label={t('activityLog.categoryAll')}
            selected={filters.categories.length === 0}
            onSelect={() => setFilters((prev) => ({ ...prev, categories: [] }))}
          />
          {AUDIT_CATEGORIES.map((category) => (
            <Segment
              key={category}
              label={t('activityLog.category.' + category)}
              selected={filters.categories.includes(category)}
              onSelect={() => toggleCategory(category)}
            />
          ))}
        </SegmentedControl>

        {active && (
          <div className="flex flex-wrap items-center gap-2">
            {spaceName && <FilterChip label={spaceName} onRemove={() => setFilters((prev) => ({ ...prev, spaceId: null }))} />}
            {actorName && <FilterChip label={actorName} onRemove={() => setFilters((prev) => ({ ...prev, actorKey: null }))} />}
            {filters.sinceDays !== null && (
              <FilterChip label={rangeLabel} onRemove={() => setFilters((prev) => ({ ...prev, sinceDays: null }))} />
            )}
            {filters.categories.map((category) => (
              <FilterChip key={category} label={t('activityLog.category.' + category)} onRemove={() => toggleCategory(category)} />
            ))}
            <button
              type="button"
              onClick={clearAll}
              className="text-sm font-semibold text-secondary hover:underline px-2 py-1.5 focus-ring rounded-lg"
            >
              {t('activityLog.clearAll')}
            </button>
          </div>
        )}
      </div>
    </section>
  )
}
