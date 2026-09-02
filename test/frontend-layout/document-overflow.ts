// Shared document-overflow probe for the layout harnesses.
//
// The app shell is a fixed-viewport surface: the root `min-h-screen`, the `<main>` top padding
// and the screen's own `h-[calc(100vh-5rem-var(--banner-h))]` sum to exactly 100vh. So the
// DOCUMENT must never become scrollable — an OS-level scrollbar over the whole window (outside
// every pane that legitimately scrolls) is the user-visible symptom of a box that escaped its
// clipping ancestor.
//
// The helpers below are the diagnosis kit: which elements poke below the viewport, whether an
// ancestor clips them (so they cannot contribute to the document scroll height), and what the
// shell containers measure at that moment.

export interface Offender {
  tag: string
  cls: string
  top: number
  bottom: number
  height: number
  clipped: boolean
  pos: string
}

// Does an ancestor establish a containing block for an absolutely-positioned descendant?
function isContainingBlock(s: CSSStyleDeclaration): boolean {
  return s.position !== 'static' || s.transform !== 'none' || s.filter !== 'none' || s.contain.includes('paint')
}

// Is anything between `el` and <html> clipping it (so it can't contribute to the DOCUMENT scroll
// height)? Rows inside a list's `overflow-y-auto` pane are clipped — unless they are positioned
// against an ancestor OUTSIDE that pane, which is exactly the bug class this catches: an
// absolutely-positioned box is clipped only from its containing block upwards, so a scroll pane
// it merely sits inside in the DOM does not contain it. Walking parents alone would call such a
// box clipped and hide the one element that is growing the document.
function clippedByAncestor(el: Element): boolean {
  let seekingContainingBlock = getComputedStyle(el).position === 'absolute'
  let p = el.parentElement
  while (p && p !== document.documentElement) {
    const s = getComputedStyle(p)
    if (seekingContainingBlock) {
      if (!isContainingBlock(s)) { p = p.parentElement; continue }
      seekingContainingBlock = false
    }
    if (s.overflowY !== 'visible' || s.overflowX !== 'visible') return true
    p = p.parentElement
  }
  return false
}

// Every element whose bottom escapes the viewport, annotated with whether it's clipped and its
// position — so the real (non-clipped, non-fixed) contributor sorts to the top.
export function offenders(ih: number): Offender[] {
  const out: Offender[] = []
  for (const el of Array.from(document.querySelectorAll('body *'))) {
    const r = el.getBoundingClientRect()
    if (r.height > 0 && r.bottom > ih + 1) {
      const pos = getComputedStyle(el).position
      out.push({
        tag: el.tagName.toLowerCase(),
        cls: String((el as HTMLElement).className || '').slice(0, 70),
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        height: Math.round(r.height),
        clipped: clippedByAncestor(el),
        pos,
      })
    }
  }
  out.sort((a, b) => {
    const aReal = !a.clipped && a.pos !== 'fixed'
    const bReal = !b.clipped && b.pos !== 'fixed'
    if (aReal !== bReal) return aReal ? -1 : 1
    return b.bottom - a.bottom
  })
  return out.slice(0, 16)
}

// Every positioned (absolute/fixed/sticky) element — to catch an overlay whose containing block
// sits outside the pane that was supposed to clip it.
export function positioned(): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const el of Array.from(document.querySelectorAll('body, body *'))) {
    const s = getComputedStyle(el)
    if (s.position === 'absolute' || s.position === 'fixed' || s.position === 'sticky') {
      const r = el.getBoundingClientRect()
      out.push({
        tag: el.tagName.toLowerCase(), pos: s.position,
        cls: String((el as HTMLElement).className || '').slice(0, 70),
        top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height),
        cssTop: s.top, cssBottom: s.bottom, cssHeight: s.height,
        parent: el.parentElement?.tagName.toLowerCase() ?? '',
      })
    }
  }
  return out
}

export function bodyChildren(): Array<Record<string, unknown>> {
  return Array.from(document.body.children).map((el) => {
    const r = el.getBoundingClientRect()
    return {
      tag: el.tagName.toLowerCase(),
      cls: String((el as HTMLElement).className || '').slice(0, 70),
      top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height),
    }
  })
}

export function containerMetrics(): Record<string, unknown> {
  const pick = (sel: string) => {
    const el = document.querySelector(sel) as HTMLElement | null
    if (!el) return null
    const r = el.getBoundingClientRect()
    const s = getComputedStyle(el)
    return {
      sel, top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height),
      scrollH: el.scrollHeight, clientH: el.clientHeight, overflowY: s.overflowY, pt: s.paddingTop,
    }
  }
  return {
    html: { scrollH: document.documentElement.scrollHeight, clientH: document.documentElement.clientHeight },
    body: pick('body'),
    root: pick('#root > div'),
    main: pick('main'),
    screen: pick('main > div > div'),
  }
}

// The user-visible symptom: can the whole document be scrolled (revealing empty space below)?
// Unlike raw scrollHeight this reflects the actual OS scrollbar.
export function documentScrollable(): boolean {
  const el = document.scrollingElement || document.documentElement
  const before = el.scrollTop
  el.scrollTop = 100000
  const can = el.scrollTop > 0
  el.scrollTop = before
  return can
}

// The clipping chain above an element: where a box that pokes below the viewport stops being
// somebody's problem. Reads the rect, the scroll geometry and the overflow of every ancestor up
// to <body>, so a failure names the box that grew rather than the row that noticed.
export function ancestorChain(el: Element | null): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  let cur: Element | null = el
  while (cur && cur !== document.documentElement) {
    const r = cur.getBoundingClientRect()
    const s = getComputedStyle(cur)
    out.push({
      tag: cur.tagName.toLowerCase(),
      cls: String((cur as HTMLElement).className || '').slice(0, 70),
      top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height),
      scrollH: (cur as HTMLElement).scrollHeight, clientH: (cur as HTMLElement).clientHeight,
      overflowY: s.overflowY, position: s.position,
    })
    cur = cur.parentElement
  }
  return out
}
