// The Download-to controls both selecting harnesses measure: the selection strip's split Download
// button against Done, and the controls row's "Downloads to" button between the filter and Expand
// all. Each control's accessible name must contain its visible label (WCAG 2.5.3, label in name),
// compared as words the way assistive tech matches a spoken command: case and punctuation aside.
// REGRESSION (FIX-DLTO-R19: "Download 3 files to X" did not contain the visible "Download 3 to X",
// nor "Downloads go to X, drive not connected" the visible "X · not connected").

export interface SplitGeometry {
  found: boolean
  /** The main half's accessible name. */
  name: string
  /** The main half's visible label. */
  visible: string
  labelInName: boolean
  heights: number[]
  tops: number[]
  /** The bottom of each label's first line: main half, Done. */
  baselines: number[]
  aligned: boolean
  /** Halves touch: the chevron starts where the main half ends. */
  joined: boolean
  cancelShown: boolean
  /** Neither half shrinks on press, so the pair presses as one shape. */
  pressFlat: boolean
}

export interface ControlsGeometry {
  found: boolean
  name: string
  visible: string
  labelInName: boolean
  filterRight: number
  left: number
  right: number
  /** Expand all's left edge; null when the row offers none. */
  expandLeft: number | null
  between: boolean
}

const r2 = (n: number) => Math.round(n * 100) / 100

const words = (s: string) => s.toLowerCase().replace(/[\p{P}\p{S}]/gu, ' ').replace(/\s+/g, ' ').trim()
const visibleLabel = (el: HTMLElement) => el.innerText.replace(/\s+/g, ' ').trim()
const nameOf = (el: HTMLElement) => el.getAttribute('aria-label') ?? visibleLabel(el)
const labelInName = (el: HTMLElement) => words(nameOf(el)).includes(words(visibleLabel(el)))

function textBottom(el: Element): number {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (n) => ((n.textContent ?? '').trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP) })
  const node = walker.nextNode()
  if (!node) return -1
  const range = document.createRange()
  range.selectNodeContents(node)
  return r2(range.getBoundingClientRect().bottom)
}

function buttonWithText(text: RegExp): HTMLButtonElement | null {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('main button')).find((b) => text.test((b.textContent ?? '').trim())) ?? null
}

export function splitGeometry(): SplitGeometry {
  const group = document.querySelector<HTMLElement>('[role=group][aria-label="Download"]')
  const [main, chevron] = group ? Array.from(group.querySelectorAll<HTMLButtonElement>('button')) : []
  const done = buttonWithText(/^Done$/)
  const cancelShown = buttonWithText(/^Cancel \d+$/) !== null
  if (!main || !chevron || !done) return { found: false, name: '', visible: '', labelInName: false, heights: [], tops: [], baselines: [], aligned: false, joined: false, cancelShown, pressFlat: false }
  const rects = [main, chevron, done].map((b) => b.getBoundingClientRect())
  const heights = rects.map((r) => r2(r.height))
  const tops = rects.map((r) => r2(r.top))
  const baselines = [textBottom(main), textBottom(done)]
  const aligned = Math.max(...heights) - Math.min(...heights) <= 0.5 && Math.max(...tops) - Math.min(...tops) <= 0.5 && Math.abs(baselines[0] - baselines[1]) <= 0.5
  const joined = Math.abs(rects[0].right - rects[1].left) <= 0.5
  const pressFlat = ![main, chevron].some((b) => /(^|\s)active:scale-/.test(b.className))
  return { found: true, name: nameOf(main), visible: visibleLabel(main), labelInName: labelInName(main), heights, tops, baselines, aligned, joined, cancelShown, pressFlat }
}

export function controlsGeometry(): ControlsGeometry {
  const button = document.querySelector<HTMLButtonElement>('main button[aria-label^="Downloads go to"]')
  const filter = document.querySelector<HTMLElement>('input[type=search]')?.parentElement ?? null
  const expand = buttonWithText(/^(Expand|Collapse) all$/)
  if (!button || !filter) return { found: false, name: '', visible: '', labelInName: false, filterRight: -1, left: -1, right: -1, expandLeft: null, between: false }
  const rect = button.getBoundingClientRect()
  const filterRight = r2(filter.getBoundingClientRect().right)
  const expandLeft = expand ? r2(expand.getBoundingClientRect().left) : null
  const between = rect.left >= filterRight && (expandLeft === null || rect.right <= expandLeft)
  return { found: true, name: nameOf(button), visible: visibleLabel(button), labelInName: labelInName(button), filterRight, left: r2(rect.left), right: r2(rect.right), expandLeft, between }
}
