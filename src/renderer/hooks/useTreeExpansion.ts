import { useCallback, useRef, useState } from 'react'

// Session-scoped expansion store, keyed by shareId. Survives navigating away from a
// folder and back within a session (FolderView unmounts/remounts); resets on app
// restart. Deliberately not persisted — expansion is ephemeral view state.
const store = new Map<string, Set<string>>()

export function useTreeExpansion(shareId: string) {
  const initial = useRef<Set<string>>(store.get(shareId) ?? new Set())
  const [expanded, setExpanded] = useState<Set<string>>(initial.current)
  const storedRef = useRef(store.has(shareId))

  const commit = useCallback((next: Set<string>) => {
    storedRef.current = true
    store.set(shareId, next)
    setExpanded(next)
  }, [shareId])

  const toggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      storedRef.current = true
      store.set(shareId, next)
      return next
    })
  }, [shareId])

  const expandAll = useCallback((paths: string[]) => commit(new Set(paths)), [commit])
  const collapseAll = useCallback(() => commit(new Set()), [commit])
  const isExpanded = useCallback((path: string) => expanded.has(path), [expanded])
  const hasStored = useCallback(() => storedRef.current, [])

  return { expanded, isExpanded, toggle, expandAll, collapseAll, hasStored }
}
