import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export function useHasVerticalOverflow<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [hasOverflow, setHasOverflow] = useState(false)

  useLayoutEffect(() => {
    const el = ref.current
    if (el) setHasOverflow(el.scrollHeight > el.clientHeight)
  })

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      setHasOverflow(el.scrollHeight > el.clientHeight)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return { ref, hasOverflow }
}
