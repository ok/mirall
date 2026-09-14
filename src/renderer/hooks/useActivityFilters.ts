import { useCallback, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuditFacets, hasActiveFilters, EMPTY_FILTERS } from './useAuditLog.js'
import { emptyStateFor } from '../model/auditRow.js'
import { KINDS } from '../../shared/contract/audit-kinds.js'
import type { AuditCategory, AuditFilters } from '../types/types.js'

// The kind names, so a search term typed in any locale can be matched against the TRANSLATED
// labels and turned into a `kinds` filter: the stored search blob is proper nouns only.
const AUDIT_KINDS: readonly string[] = Object.keys(KINDS)

/**
 * The activity log's filter state, the names its chips and triggers read, and the search field the
 * palette focuses.
 *
 * `kinds` is the part that cannot live in the query: a term typed in the viewer's own language is
 * matched against the TRANSLATED kind labels here and sent down as an explicit kind list, because
 * the stored search blob holds proper nouns only — without it a German user searching "genehmigt"
 * would match nothing.
 */
export function useActivityFilters(initialFilters?: Partial<AuditFilters>) {
  const { t } = useTranslation()
  // Lazy initialiser: a preset seeds the FIRST render only, so a re-render never clobbers a filter
  // the user has since changed. Clear all resets to EMPTY_FILTERS, not to the preset.
  const [filters, setFilters] = useState<AuditFilters>(() => ({ ...EMPTY_FILTERS, ...initialFilters }))
  const searchRef = useRef<HTMLInputElement>(null)
  const { spaces, actors } = useAuditFacets()

  const kinds = useMemo(() => {
    const term = filters.search.trim().toLowerCase()
    if (!term) return null
    return AUDIT_KINDS.filter((kind) => t('activityLog.kindLabel.' + kind).toLowerCase().includes(term))
  }, [filters.search, t])

  const toggleCategory = useCallback((category: AuditCategory) => {
    setFilters((prev) => ({
      ...prev,
      categories: prev.categories.includes(category)
        ? prev.categories.filter((c) => c !== category)
        : [...prev.categories, category],
    }))
  }, [])

  const clearAll = useCallback(() => setFilters(EMPTY_FILTERS), [])
  const active = hasActiveFilters(filters)

  return {
    filters,
    setFilters,
    kinds,
    active,
    empty: emptyStateFor(filters, active),
    toggleCategory,
    clearAll,
    searchRef,
    spaces,
    actors,
    // A facet that has fallen out of the roster still has to name itself, so each falls back to
    // the id it filtered on rather than reading as "all".
    spaceName: filters.spaceId ? (spaces.find((s) => s.id === filters.spaceId)?.name ?? filters.spaceId) : null,
    actorName: filters.actorKey ? (actors.find((a) => a.key === filters.actorKey)?.name ?? filters.actorKey) : null,
    rangeLabel: filters.sinceDays === null
      ? t('activityLog.anyTime')
      : t('activityLog.lastNDays', { count: filters.sinceDays }),
  }
}
