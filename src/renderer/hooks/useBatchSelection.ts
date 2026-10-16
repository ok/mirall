// Selecting on one listing: whether the column is open, which rows are ticked and the shift
// anchor. The column outlives an empty selection; Done, Esc, a sent action or leaving the listing
// end it. Screen-local by design: a selection never survives navigating away, and a screen prop
// that changes without a remount (another space, another folder) resets it during render.
import { useCallback, useRef, useState } from 'react'
import {
  AT_REST, TOP_BOX, keepMatching, nextSelection, selectAllMatching, triState,
  type Gesture, type SelectionState, type TriState,
} from '../model/batch-selection.js'

interface BatchSelectionArgs {
  scopeKey: string
  order: readonly string[]
  filesUnder: (path: string) => readonly string[]
  matching: ReadonlySet<string>
}

export interface BatchSelection {
  mode: boolean
  selected: ReadonlySet<string>
  topState: TriState
  /** One entry point for every pointer and box gesture; false when the gesture was not a selection. */
  select: (id: string, gesture: Gesture) => boolean
  toggleTop: () => void
  selectAll: () => void
  deselectHidden: () => void
  end: () => void
}

export function useBatchSelection({ scopeKey, order, filesUnder, matching }: BatchSelectionArgs): BatchSelection {
  const [state, setState] = useState<SelectionState>(AT_REST)
  const [prevScope, setPrevScope] = useState(scopeKey)
  // Gestures read the live state through a ref: two clicks inside one frame must see each other.
  const live = useRef(state)
  if (prevScope !== scopeKey) {
    setPrevScope(scopeKey)
    live.current = AT_REST
    setState(AT_REST)
  }
  const ctx = useRef({ order, filesUnder, matching })
  ctx.current = { order, filesUnder, matching }

  const commit = useCallback((next: SelectionState) => {
    live.current = next
    setState(next)
  }, [])

  const select = useCallback((id: string, gesture: Gesture) => {
    const next = nextSelection(live.current, id, gesture, ctx.current)
    if (!next) return false
    commit(next)
    return true
  }, [commit])

  const toggleTop = useCallback(() => { select(TOP_BOX, 'toggle') }, [select])
  const selectAll = useCallback(() => { commit(selectAllMatching(live.current, ctx.current.matching)) }, [commit])
  const deselectHidden = useCallback(() => {
    commit({ ...live.current, selected: keepMatching(live.current.selected, ctx.current.matching) })
  }, [commit])
  const end = useCallback(() => { commit(AT_REST) }, [commit])

  return {
    mode: state.mode,
    selected: state.selected,
    topState: state.mode ? triState([...matching], state.selected) : 'off',
    select,
    toggleTop,
    selectAll,
    deselectHidden,
    end,
  }
}
