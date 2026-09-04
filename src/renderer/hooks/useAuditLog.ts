import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { request, subscribe } from '../ipc.js'
import { Scope, scopeMatches } from '../scope.js'
import { useQuery } from '../store/useQuery.js'
import type { AuditEntry, AuditFilters, AuditPage, AuditSpaceRef, AuditActorRef, AuditCategory } from '../types.js'
import { useErrorText } from './useErrorText.js'

// Sized against the list's visible window (~8-10 rows) rather than the query budget: a page much
// larger than the viewport turns "Load more" into a scroll marathon instead of a step.
const PAGE_SIZE = 20

export const EMPTY_FILTERS: AuditFilters = {
  spaceId: null,
  categories: [],
  actorKey: null,
  search: '',
  sinceDays: null,
}

export function hasActiveFilters(filters: AuditFilters): boolean {
  return Boolean(
    filters.spaceId ||
    filters.categories.length ||
    filters.actorKey ||
    filters.search.trim() ||
    filters.sinceDays,
  )
}

interface ReconcileMessage {
  scope?: { kind: string }
}

// `kinds` resolution happens in the caller: the renderer holds the translated kind labels, so a
// term typed in any locale can be turned into a kind filter the worker understands. The stored
// search blob is proper nouns only and stays locale-neutral.
export function useAuditLog(filters: AuditFilters, kinds: string[] | null) {
  const errorText = useErrorText()
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [cursor, setCursor] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const runRef = useRef(0)

  const query = useMemo(() => ({
    spaceId: filters.spaceId,
    categories: filters.categories.length ? filters.categories : null,
    actorKey: filters.actorKey,
    search: filters.search.trim() || null,
    since: filters.sinceDays === null ? null : Date.now() - filters.sinceDays * 86400000,
    kinds: kinds && kinds.length ? kinds : null,
  }), [filters.spaceId, filters.categories, filters.actorKey, filters.search, filters.sinceDays, kinds])

  const reload = useCallback(async () => {
    const run = ++runRef.current
    setLoading(true)
    try {
      const page = await request('audit:list', { ...query, cursor: null, limit: PAGE_SIZE }) as AuditPage
      if (run !== runRef.current) return
      setEntries(page.entries)
      setCursor(page.nextCursor)
      setError(null)
    } catch (err) {
      if (run !== runRef.current) return
      setError(errorText(err))
    } finally {
      if (run === runRef.current) setLoading(false)
    }
  }, [query, errorText])

  // A partial page is normal under a filter (the worker walks a bounded budget), so "there is
  // more" is the cursor being non-null — never entries.length < PAGE_SIZE.
  const loadMore = useCallback(async () => {
    if (cursor === null || loadingMore) return
    const run = runRef.current
    setLoadingMore(true)
    try {
      const page = await request('audit:list', { ...query, cursor, limit: PAGE_SIZE }) as AuditPage
      if (run !== runRef.current) return
      setEntries((prev) => [...prev, ...page.entries])
      setCursor(page.nextCursor)
    } catch (err) {
      if (run === runRef.current) setError(errorText(err))
    } finally {
      if (run === runRef.current) setLoadingMore(false)
    }
  }, [cursor, loadingMore, query, errorText])

  useEffect(() => { void reload() }, [reload])

  useEffect(() => subscribe<ReconcileMessage>('event:reconcile', (msg) => {
    if (msg.scope && scopeMatches(msg.scope, Scope.audit())) void reload()
  }), [reload])

  return { entries, loading, loadingMore, error, hasMore: cursor !== null, loadMore, reload }
}

// Both come from the LOG, not from spaces:list — a space the user has left keeps its rows and must
// stay filterable, but its record is gone.
//
// Two entries rather than one Promise.all: they re-derive on the same hint but are separately
// cacheable, and a failure in one no longer blanks the other. Module constants for the empty case,
// because a fresh [] per render would break memo identity in the filter bar.
const AUDIT_SCOPES = [Scope.audit()]
const NO_SPACES: AuditSpaceRef[] = []
const NO_ACTORS: AuditActorRef[] = []

export function useAuditFacets() {
  const { data: spaces } = useQuery<AuditSpaceRef[]>('audit:spaces', {}, AUDIT_SCOPES)
  const { data: actors } = useQuery<AuditActorRef[]>('audit:actors', {}, AUDIT_SCOPES)
  return { spaces: spaces ?? NO_SPACES, actors: actors ?? NO_ACTORS }
}

export const AUDIT_CATEGORIES: AuditCategory[] = ['members', 'files', 'folders', 'security', 'network']
