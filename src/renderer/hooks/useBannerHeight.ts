// Publishes a top banner's live height as --banner-h on :root, so the fixed nav's content offset and
// every screen's `100vh - navHeight` scroll area grow by exactly this much — pushing content down
// instead of letting the banner overlay it. Reset to 0 whenever the banner is not shown.
import { useLayoutEffect, type RefObject } from 'react'

export function useBannerHeight(ref: RefObject<HTMLDivElement | null>, shown: boolean) {
  useLayoutEffect(() => {
    const root = document.documentElement
    const el = ref.current
    if (!shown || !el) {
      root.style.setProperty('--banner-h', '0px')
      return
    }
    const apply = () => root.style.setProperty('--banner-h', `${el.offsetHeight}px`)
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    return () => {
      ro.disconnect()
      root.style.setProperty('--banner-h', '0px')
    }
  }, [ref, shown])
}
