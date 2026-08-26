import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useHasVerticalOverflow } from '../hooks/useHasVerticalOverflow.js'
import { useAuditLog, useAuditFacets, hasActiveFilters, EMPTY_FILTERS, AUDIT_CATEGORIES } from '../hooks/useAuditLog.js'
import { actorInitials, avatarKind, denialReasonKey, groupByDay, metaParts, rowBadge, sentenceKey, sentenceValues, sentinelValues, splitSentence } from '../auditRow.js'
import { AUDIT_KINDS } from '../auditKinds.js'
import type { AuditCategory, AuditEntry, AuditFilters } from '../types.js'
import Icon from '../components/primitives/Icon.js'
import ActionMenu, { type ActionMenuItemConfig } from '../components/widgets/ActionMenu.js'
import PageHeader from '../components/layout/PageHeader.js'

interface ActivityLogProps {
  onBack: () => void
  onOpenSettings: () => void
}

const ACTION_BUTTON = 'shrink-0 bg-surface-container-high dark:bg-surface-container-highest text-accent rounded-xl px-5 py-2.5 font-headline font-bold text-sm hover:bg-surface-container-highest dark:hover:bg-surface-container-high active:scale-95 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30'
const DAY_RANGES = [7, 30, 90]

function timeOf(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

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

function AuditRow({ entry }: { entry: AuditEntry }) {
  const { t } = useTranslation()
  const badge = rowBadge(entry)
  // The reason trails the row's own context (space, totals): "DENIED" says something was refused,
  // this says what a reader should do about it — nothing, if we simply had no verified identity yet.
  const reasonKey = denialReasonKey(entry)
  const meta = [...metaParts(entry), ...(reasonKey ? [t(reasonKey)] : [])].join(' · ')
  const avatar = avatarKind(entry)
  const badgeClasses = badge?.tone === 'error'
    ? 'bg-error-container text-on-error-container'
    : 'bg-surface-container-highest text-on-surface-variant'

  return (
    <li className="px-6 py-4 flex items-start gap-4 hover:bg-surface-container-high/50 transition-colors">
      <span
        aria-hidden="true"
        className="w-8 h-8 rounded-full bg-surface-container-highest text-accent flex items-center justify-center text-xs font-headline font-bold shrink-0"
      >
        {avatar === 'system' ? <Icon name="history" size={16} /> : avatar === 'self' ? t('activityLog.actorSelf') : actorInitials(entry)}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          {/* The entity names carry the meaning of the row, so they are set apart from the
              surrounding prose — otherwise "You deleted the folder share Large Files" reads as
              one undifferentiated line. Emphasis is weight + the accent colour, the app's
              existing in-body emphasis; a highlight fill would collide with the status palette's
              five fixed meanings. */}
          <p className="text-sm text-on-surface-variant min-w-0">
            {splitSentence(t(sentenceKey(entry), sentinelValues()), sentenceValues(entry)).map((seg, i) => (
              seg.field
                ? <span key={i} className="font-semibold text-accent">{seg.value}</span>
                : <span key={i}>{seg.text}</span>
            ))}
          </p>
          {badge && (
            <span className={`inline-flex items-center leading-none px-3 pt-[7px] pb-[5px] text-[10px] font-bold rounded-full uppercase tracking-wider border border-outline shrink-0 ${badgeClasses}`}>
              {t(badge.labelKey)}
            </span>
          )}
        </div>
        {meta && <p className="text-xs text-on-surface-variant mt-0.5 truncate">{meta}</p>}
      </div>
      <span className="text-xs text-on-surface-variant tabular-nums shrink-0 pt-0.5">{timeOf(entry.ts)}</span>
    </li>
  )
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
        className="w-5 h-5 rounded-full flex items-center justify-center hover:bg-surface-container-highest dark:hover:bg-surface-container-high focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30"
      >
        <Icon name="close" size={12} />
      </button>
    </span>
  )
}

export default function ActivityLog({ onBack, onOpenSettings }: ActivityLogProps) {
  const { t } = useTranslation()
  const { ref, hasOverflow } = useHasVerticalOverflow<HTMLDivElement>()
  const [filters, setFilters] = useState<AuditFilters>(EMPTY_FILTERS)
  const { spaces, actors } = useAuditFacets(0)

  // A term typed in the viewer's own language is matched against the TRANSLATED kind labels and
  // sent as a `kinds` filter. The stored search blob holds proper nouns only, so without this a
  // German user searching "genehmigt" would match nothing.
  const kinds = useMemo(() => {
    const term = filters.search.trim().toLowerCase()
    if (!term) return null
    return AUDIT_KINDS.filter((kind) => t('activityLog.kindLabel.' + kind).toLowerCase().includes(term))
  }, [filters.search, t])

  const { entries, loading, loadingMore, error, hasMore, loadMore } = useAuditLog(filters, kinds)
  const groups = useMemo(() => groupByDay(entries), [entries])
  const active = hasActiveFilters(filters)

  const toggleCategory = useCallback((category: AuditCategory) => {
    setFilters((prev) => ({
      ...prev,
      categories: prev.categories.includes(category)
        ? prev.categories.filter((c) => c !== category)
        : [...prev.categories, category],
    }))
  }, [])

  const clearAll = useCallback(() => setFilters(EMPTY_FILTERS), [])

  const spaceName = filters.spaceId ? (spaces.find((s) => s.id === filters.spaceId)?.name ?? filters.spaceId) : null
  const actorName = filters.actorKey ? (actors.find((a) => a.key === filters.actorKey)?.name ?? filters.actorKey) : null
  const rangeLabel = filters.sinceDays === null
    ? t('activityLog.anyTime')
    : t('activityLog.lastNDays', { count: filters.sinceDays })

  return (
    <div
      ref={ref}
      className={`relative h-[calc(100vh-5.5rem-var(--banner-h,0px))] overflow-y-auto scrollbar-thin pb-8 mr-2 ${hasOverflow ? 'pr-4' : ''}`}
    >
      <div className="pt-8 px-8 max-w-2xl mx-auto">
        <PageHeader title={t('activityLog.title')} subtitle={t('activityLog.intro')} onBack={onBack} />

        <div className="space-y-10">
          <section>
            <div className="bg-surface-container-low rounded-xl p-6 space-y-4">
              <div className="relative">
                <span className="absolute left-4 top-1/2 -translate-y-1/2 text-outline pointer-events-none">
                  <Icon name="search" size={18} />
                </span>
                <input
                  type="search"
                  aria-label={t('activityLog.searchLabel')}
                  placeholder={t('activityLog.searchPlaceholder')}
                  value={filters.search}
                  onChange={(e) => setFilters((prev) => ({ ...prev, search: e.target.value }))}
                  className="w-full bg-surface-container-lowest border-none rounded-xl pl-11 pr-4 py-4 text-sm text-on-surface placeholder:text-on-surface-variant/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30"
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

              <div className="flex bg-surface-container-high dark:bg-surface-container-highest p-1 rounded-full w-fit">
                <button
                  type="button"
                  aria-pressed={filters.categories.length === 0}
                  onClick={() => setFilters((prev) => ({ ...prev, categories: [] }))}
                  className={`px-4 py-2 rounded-full text-sm transition-all active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30 ${
                    filters.categories.length === 0
                      ? 'bg-surface-container-lowest shadow-sm text-accent font-semibold'
                      : 'text-on-surface-variant hover:text-accent font-medium'
                  }`}
                >
                  {t('activityLog.categoryAll')}
                </button>
                {AUDIT_CATEGORIES.map((category) => {
                  const on = filters.categories.includes(category)
                  return (
                    <button
                      key={category}
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggleCategory(category)}
                      className={`px-4 py-2 rounded-full text-sm transition-all active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30 ${
                        on
                          ? 'bg-surface-container-lowest shadow-sm text-accent font-semibold'
                          : 'text-on-surface-variant hover:text-accent font-medium'
                      }`}
                    >
                      {t('activityLog.category.' + category)}
                    </button>
                  )
                })}
              </div>

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
                    className="text-sm font-semibold text-secondary hover:underline px-2 py-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30 rounded-lg"
                  >
                    {t('activityLog.clearAll')}
                  </button>
                </div>
              )}
            </div>
          </section>

          <section>
            <div className="flex items-baseline justify-between mb-6">
              <h2 className="text-xl font-headline font-bold text-accent">{t('activityLog.events')}</h2>
              {/* Never "N of M": a filtered total would need a full scan, and the query walks a
                  bounded budget, so the honest affordance is a count plus Load more. */}
              <p role="status" aria-live="polite" className="text-xs text-on-surface-variant tabular-nums">
                {loading ? t('activityLog.loading') : t('activityLog.showingCount', { count: entries.length })}
              </p>
            </div>

            {error && <p role="alert" className="text-sm text-error mb-4">{error}</p>}

            {!loading && entries.length === 0 ? (
              <div className="bg-surface-container-low rounded-xl p-10 text-center">
                <div className="w-12 h-12 rounded-full bg-surface-container-high mx-auto flex items-center justify-center text-on-surface-variant mb-4">
                  <Icon name={active ? 'search' : 'history'} size={22} />
                </div>
                <p className="font-semibold text-accent mb-1">{t(active ? 'activityLog.emptyFilteredTitle' : 'activityLog.emptyTitle')}</p>
                <p className="text-sm text-on-surface-variant mb-5">{t(active ? 'activityLog.emptyFilteredDesc' : 'activityLog.emptyDesc')}</p>
                {active && (
                  <button type="button" onClick={clearAll} className={ACTION_BUTTON}>
                    {t('activityLog.clearFilters')}
                  </button>
                )}
              </div>
            ) : (
              <div className="bg-surface-container-low rounded-xl overflow-hidden">
                {/* The list is its own scroll region rather than growing the page: a 90-day log
                    would otherwise stretch the screen without limit as pages are appended. It
                    also makes the day headings pin the way they are meant to — against the list,
                    not the page. */}
                <div className="max-h-[clamp(20rem,52vh,40rem)] overflow-y-auto scrollbar-thin">
                <ul>
                  {groups.map((group) => (
                    <li key={group.key}>
                      <h3 className="sticky top-0 z-10 bg-surface-container-low px-6 pt-5 pb-2 text-xs font-bold uppercase tracking-wide text-secondary">
                        {group.key === 'today' || group.key === 'yesterday'
                          ? t('activityLog.' + group.key)
                          : new Date(group.entries[0].ts).toLocaleDateString()}
                      </h3>
                      <ul>
                        {group.entries.map((entry) => (
                          <AuditRow key={entry.seq} entry={entry} />
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
                </div>
                {hasMore && (
                  <div className="px-6 py-4 border-t border-outline-variant/40 flex justify-center">
                    <button type="button" onClick={() => void loadMore()} disabled={loadingMore} className={`${ACTION_BUTTON} disabled:opacity-50`}>
                      {loadingMore ? t('activityLog.loading') : t('activityLog.loadMore')}
                    </button>
                  </div>
                )}
              </div>
            )}
          </section>

          <section>
            <button
              type="button"
              onClick={onOpenSettings}
              aria-label={t('activityLog.logSettings')}
              className="w-full bg-surface-container-low rounded-xl p-6 flex items-center gap-4 text-left hover:bg-surface-container-high/50 active:scale-[0.99] transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30 cursor-pointer"
            >
              <div className="w-10 h-10 rounded-full bg-icon-tile flex items-center justify-center text-on-icon-tile shrink-0">
                <Icon name="tune" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-accent">{t('activityLog.logSettings')}</p>
                <p className="text-xs text-on-surface-variant">{t('activityLog.logSettingsDesc')}</p>
              </div>
              <Icon name="chevron_right" className="text-secondary" />
            </button>
          </section>
        </div>
      </div>
    </div>
  )
}
