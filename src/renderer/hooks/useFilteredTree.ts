import { useState, useEffect, useMemo, useRef, useDeferredValue } from 'react'
import { useTreeExpansion } from './useTreeExpansion.js'
import { buildFileTree, collectFolderPaths, topLevelFolderPaths } from '../fileTree.js'
import { filterTree } from '../folderFilter.js'
import type { FileTreeNode, ShareFileEntry } from '../types.js'

/**
 * The folder tree a share's file list renders as: built, filtered, and expanded.
 *
 * Expansion has exactly one home — the session store keyed by share — so a disclosure button
 * always toggles what it says it toggles. A filter reveals matches by writing THROUGH that store,
 * and snapshots what the user had open first, so clearing the filter puts it back.
 */
export function useFilteredTree(shareId: string, files: readonly ShareFileEntry[]) {
  const [filter, setFilter] = useState('')
  const tree = useMemo<FileTreeNode[]>(() => buildFileTree(files), [files])
  const { expanded, isExpanded, toggle, expandAll, collapseAll, hasStored } = useTreeExpansion(shareId)
  // Filtering a 5,000-row tree on every keystroke is two O(n) walks — cheap — but the RENDER of
  // what comes back is not, so the typed value stays responsive while the tree lags a frame.
  const deferredFilter = useDeferredValue(filter)
  const { nodes: visibleTree, matched, revealPaths } = useMemo(() => filterTree(tree, deferredFilter), [tree, deferredFilter])
  const allFolderPaths = useMemo<string[]>(() => collectFolderPaths(visibleTree), [visibleTree])
  const anyExpanded = allFolderPaths.some(isExpanded)

  const expandedRef = useRef(expanded)
  expandedRef.current = expanded
  const preFilterRef = useRef<Set<string> | null>(null)
  const revealedForRef = useRef<string | null>(null)
  useEffect(() => {
    const term = deferredFilter.trim()
    if (!term) {
      const snapshot = preFilterRef.current
      preFilterRef.current = null
      revealedForRef.current = null
      if (snapshot) expandAll([...snapshot])
      return
    }
    if (!preFilterRef.current) preFilterRef.current = new Set(expandedRef.current)
    // Once per term, not once per rebuild: the tree is rebuilt on every progress tick, and
    // re-applying the reveal each time would undo a branch the user collapsed under the filter.
    if (!revealPaths || revealedForRef.current === term) return
    revealedForRef.current = term
    expandAll([...new Set([...preFilterRef.current, ...revealPaths])])
  }, [deferredFilter, revealPaths, expandAll])

  // Seed the default (top-level folders open) unless this share already has an expansion stored
  // this session. The store is the only gate: the screen is keyed per share, so a mount is a share,
  // and expandAll writes through to the store before this can run twice.
  useEffect(() => {
    if (hasStored() || tree.length === 0) return
    const top = topLevelFolderPaths(tree)
    if (top.length) expandAll(top)
  }, [tree, hasStored, expandAll])

  // Expand-all unions with what is already open rather than replacing it: under a filter the
  // visible set is a subset, and replacing would collapse branches the user opened outside it.
  const toggleAll = () => (anyExpanded ? collapseAll() : expandAll([...expanded, ...allFolderPaths]))

  return {
    filter,
    setFilter,
    // The deferred value, not `filter`: the empty-result copy must name the term the tree was
    // actually filtered by, or it reads one keystroke ahead of what is on screen.
    deferredFilter,
    tree,
    visibleTree,
    matched,
    allFolderPaths,
    anyExpanded,
    isExpanded,
    toggle,
    toggleAll,
  }
}
