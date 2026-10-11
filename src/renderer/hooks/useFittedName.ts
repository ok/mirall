import { useLayoutEffect, useState, type RefObject } from 'react'
import { middleTruncateToWidth } from '../model/share-paths.js'

// A long file list mounts one of these per row, so every instance shares one canvas and one
// ResizeObserver rather than allocating its own.
let context: CanvasRenderingContext2D | null | undefined
const onResize = new WeakMap<Element, (width: number) => void>()
let observer: ResizeObserver | null = null

function measuringContext(): CanvasRenderingContext2D | null {
  if (context === undefined) context = document.createElement('canvas').getContext('2d')
  return context
}

function observe(el: Element, callback: (width: number) => void): () => void {
  observer ??= new ResizeObserver((entries) => {
    for (const entry of entries) onResize.get(entry.target)?.(entry.contentRect.width)
  })
  onResize.set(el, callback)
  observer.observe(el)
  return () => {
    onResize.delete(el)
    observer?.unobserve(el)
  }
}

// Middle-truncates `name` to the width of `hostRef`, measured in the host's font. `lead` and
// `after` are text sharing the name's line, so they count against the same budget.
export default function useFittedName(
  name: string,
  hostRef: RefObject<HTMLElement | null>,
  lead = '',
  after = '',
): string {
  const [display, setDisplay] = useState(name)

  useLayoutEffect(() => {
    const host = hostRef.current
    const ctx = measuringContext()
    if (!host || !ctx) {
      setDisplay(name)
      return
    }

    const cs = getComputedStyle(host)
    const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
    // The canvas rejects `normal`, which would keep the previous caller's spacing.
    const spacing = cs.letterSpacing === 'normal' ? '0px' : cs.letterSpacing
    let fittedWidth = -1
    const fit = (width: number, force = false) => {
      if (width === fittedWidth && !force) return
      fittedWidth = width
      ctx.font = font
      ctx.letterSpacing = spacing
      const measure = (candidate: string) => ctx.measureText(lead + candidate + after).width
      // A pixel of slack: canvas and layout widths differ by fractions, and an overrun would let
      // the host's own end ellipsis cut the extension off.
      setDisplay(middleTruncateToWidth(name, width - 1, measure))
    }

    fit(host.getBoundingClientRect().width)
    const unobserve = observe(host, fit)
    let cancelled = false
    if (document.fonts && document.fonts.status !== 'loaded') {
      document.fonts.ready.then(() => { if (!cancelled) fit(host.getBoundingClientRect().width, true) })
    }
    return () => { cancelled = true; unobserve() }
  }, [name, hostRef, lead, after])

  return display
}
