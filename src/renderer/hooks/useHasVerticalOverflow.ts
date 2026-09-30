import { useEffect, useLayoutEffect, useRef, useState } from 'react'

// Every caller pads its list while it scrolls, and the padding changes the layout the next reading is
// taken on. Two rules keep that feedback from locking up the renderer: overflow means more than a
// pixel (a sub-pixel tie reads differently padded and unpadded), and the flag changes synchronously at
// most once per frame — a reading that contradicts the last one waits for the next frame, so a layout
// that can never settle flickers instead of recursing into React's nested-update limit.
const TOLERANCE_PX = 1

const overflows = (el: HTMLElement) => el.scrollHeight - el.clientHeight > TOLERANCE_PX

export function useHasVerticalOverflow<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [hasOverflow, setHasOverflow] = useState(false)
  const current = useRef(false)
  const changedThisFrame = useRef(false)
  const deferred = useRef<number | null>(null)

  const apply = (next: boolean) => {
    if (next === current.current) return
    if (changedThisFrame.current) {
      if (deferred.current === null) {
        deferred.current = requestAnimationFrame(() => {
          deferred.current = null
          const el = ref.current
          if (el) apply(overflows(el))
        })
      }
      return
    }
    changedThisFrame.current = true
    requestAnimationFrame(() => { changedThisFrame.current = false })
    current.current = next
    setHasOverflow(next)
  }

  useLayoutEffect(() => {
    const el = ref.current
    if (el) apply(overflows(el))
  })

  useEffect(() => {
    const el = ref.current
    if (!el) return undefined
    const ro = new ResizeObserver(() => apply(overflows(el)))
    ro.observe(el)
    return () => {
      ro.disconnect()
      if (deferred.current !== null) cancelAnimationFrame(deferred.current)
    }
  }, [])

  return { ref, hasOverflow }
}
