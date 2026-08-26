import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { request, subscribe } from '../ipc.js'
import { Scope, scopeMatches } from '../scope.js'
import type { AuditEntry, AuditFilters, AuditPage, AuditSpaceRef, AuditActorRef, AuditCategory } from '../types.js'

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
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (run === runRef.current) setLoading(false)
    }
  }, [query])

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
      if (run === runRef.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (run === runRef.current) setLoadingMore(false)
    }
  }, [cursor, loadingMore, query])

  useEffect(() => { void reload() }, [reload])

  useEffect(() => subscribe<ReconcileMessage>('event:reconcile', (msg) => {
    if (msg.scope && scopeMatches(msg.scope, Scope.audit())) void reload()
  }), [reload])

  return { entries, loading, loadingMore, error, hasMore: cursor !== null, loadMore, reload }
}

export function useAuditFacets(refreshKey: number) {
  const [spaces, setSpaces] = useState<AuditSpaceRef[]>([])
  const [actors, setActors] = useState<AuditActorRef[]>([])

  useEffect(() => {
    let cancelled = false
    // Both come from the LOG, not from spaces:list — a space the user has left keeps its rows
    // and must stay filterable, but its record is gone.
    void Promise.all([
      request('audit:spaces') as Promise<AuditSpaceRef[]>,
      request('audit:actors') as Promise<AuditActorRef[]>,
    ]).then(([s, a]) => {
      if (cancelled) return
      setSpaces(s)
      setActors(a)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [refreshKey])

  return { spaces, actors }
}

export const AUDIT_CATEGORIES: AuditCategory[] = ['members', 'files', 'folders', 'security', 'network']
