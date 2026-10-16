// Keeps keyboard focus in a container whose focused control a re-render takes away: a row's
// "Download to…" giving way to Pause once the download starts, the controls row's Downloads to
// leaving when a selection starts. Focus that fell to the page with the control goes to the
// container's first or last control (`take`), or to the container itself when it has none, so the
// keyboard keeps its place. Focus the user moved elsewhere, or let go of, is left alone.
import { useCallback, useLayoutEffect, useRef, type FocusEvent, type RefObject } from 'react'

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'

export interface KeptFocus<T extends HTMLElement> {
  ref: RefObject<T | null>
  onFocus: (e: FocusEvent<T>) => void
  onBlur: (e: FocusEvent<T>) => void
}

export function useKeepFocus<T extends HTMLElement>(take: 'first' | 'last'): KeptFocus<T> {
  const ref = useRef<T>(null)
  // The element inside that holds focus. Kept after it leaves the document, until this container
  // next commits and places focus.
  const holder = useRef<Element | null>(null)

  useLayoutEffect(() => {
    const lost = holder.current
    const container = ref.current
    if (!lost || lost.isConnected || !container) return
    holder.current = null
    if (document.activeElement && document.activeElement !== document.body) return
    const controls = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE))
    const next = (take === 'first' ? controls[0] : controls.at(-1)) ?? container
    next.focus({ preventScroll: true })
  })

  const onFocus = useCallback((e: FocusEvent<T>) => {
    holder.current = e.target
  }, [])

  // A blur toward another element is the user moving on. A blur toward nothing is either the user
  // letting go (a click on the page) or the browser reporting the focused control's removal: only a
  // control still in the document once this task ends was let go of.
  const onBlur = useCallback((e: FocusEvent<T>) => {
    const left = e.target
    if (e.relatedTarget) {
      holder.current = null
      return
    }
    queueMicrotask(() => {
      if (holder.current === left && left.isConnected) holder.current = null
    })
  }, [])

  return { ref, onFocus, onBlur }
}
