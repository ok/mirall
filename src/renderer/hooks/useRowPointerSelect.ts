// Row bodies take a click as "select" while selecting, and a modified click at rest. A pointer
// accelerator only: the row's checkbox is the control a keyboard and a screen reader use, so the
// listener is delegated on the list rather than an onClick on a non-interactive row. Clicks on a
// control inside the row (buttons, the box, links, a menu) are the control's.
import { useEffect, type RefObject } from 'react'
import { gestureOf, type Gesture } from '../model/batch-selection.js'

export function useRowPointerSelect(
  listRef: RefObject<HTMLElement | null>,
  onRow: ((key: string, gesture: Gesture) => void) | null,
): void {
  useEffect(() => {
    const el = listRef.current
    if (!el || !onRow) return
    const onClick = (e: MouseEvent) => {
      const target = e.target
      if (!(target instanceof Element)) return
      if (target.closest('button, input, label, a, [role="menu"], [role="dialog"]')) return
      const row = target.closest<HTMLElement>('[data-select-key]')
      if (!row || !row.dataset.selectKey) return
      onRow(row.dataset.selectKey, gestureOf(e))
    }
    el.addEventListener('click', onClick)
    return () => el.removeEventListener('click', onClick)
  }, [listRef, onRow])
}
