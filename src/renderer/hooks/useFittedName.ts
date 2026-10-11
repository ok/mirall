import { useLayoutEffect, useState, type RefObject } from 'react'
import { middleTruncateToWidth } from '../model/share-paths.js'

// A long file list mounts one of these per row, so every instance shares one canvas and one
// ResizeObserver rather than allocating its own.
let context: CanvasRenderingContext2D | null = null
const onResize = new WeakMap<Element, () => void>()
let observer: ResizeObserver | null = null

function measuringContext(): CanvasRenderingContext2D | null {
  context ??= document.createElement('canvas').getContext('2d')
  return context
}

function observe(el: Element, callback: () => void): () => void {
  observer ??= new ResizeObserver((entries) => {
    for (const entry of entries) onResize.get(entry.target)?.()
  })
  onResize.set(el, callback)
  observer.observe(el)
  return () => {
    onResize.delete(el)
    observer?.unobserve(el)
  }
}

// Middle-truncates `name` to the width of `hostRef`, measured in the font of `textRef`. `lead` and
// `after` are text sharing the name's line, so they count against the same budget.
export default function useFittedName(
  name: string,
  hostRef: RefObject<HTMLElement | null>,
  textRef: RefObject<HTMLElement | null>,
  lead = '',
  after = '',
): string {
  const [display, setDisplay] = useState(name)

  useLayoutEffect(() => {
    const host = hostRef.current
    const text = textRef.current
    const ctx = measuringContext()
    if (!host || !text || !ctx) {
      setDisplay(name)
      return
    }

    const remeasure = () => {
      const cs = getComputedStyle(text)
      const budget = host.getBoundingClientRect().width
      ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
      // The canvas rejects `normal`, which would keep the previous caller's spacing.
      ctx.letterSpacing = cs.letterSpacing === 'normal' ? '0px' : cs.letterSpacing
      const measure = (candidate: string) => ctx.measureText(lead + candidate + after).width
      setDisplay(middleTruncateToWidth(name, budget, measure))
    }

    remeasure()
    const unobserve = observe(host, remeasure)
    let cancelled = false
    document.fonts?.ready.then(() => { if (!cancelled) remeasure() })
    return () => { cancelled = true; unobserve() }
  }, [name, hostRef, textRef, lead, after])

  return display
}
