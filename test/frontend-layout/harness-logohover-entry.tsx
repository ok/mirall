// REGRESSION harness (FIX-366) for the top bar logo's hover treatment. The
// logo button carried `hover:opacity-80`, inherited from the text wordmark it
// replaced. Fading a wordmark rendered in the surface's own text colour is
// nearly invisible in light mode, but in dark mode white lettering at 80% over
// the dark bar reads as a grey logo — a colour change, not a dim.
//
// Mounts the REAL <TopNav> and walks the REAL stylesheet for any :hover rule
// that repaints the logo, so it catches the whole class (opacity, color, fill,
// filter) rather than one utility by name.
import './harness-bootstrap.js'
import { createRoot } from 'react-dom/client'
import './../../src/renderer/i18n.js'
import TopNav from './../../src/renderer/components/layout/TopNav.js'
import { ConnectionStatusProvider } from './../../src/renderer/hooks/useConnectionStatus.js'

interface HoverHit {
  selector: string
  property: string
  value: string
}

interface HarnessResults {
  pass: boolean
  error: string | null
  sheetsRead: number
  hoverRulesSeen: number
  buttonClasses: string
  hits: HoverHit[]
}

declare global {
  interface Window {
    __results: HarnessResults
  }
}

const noop = () => {}

createRoot(document.getElementById('root') as HTMLElement).render(
  <ConnectionStatusProvider>
    <TopNav
      profile={{ displayName: 'Alice', avatar: null } as never}
      onLogoClick={noop}
      onSettingsClick={noop}
      onAccountClick={noop}
      onFeedbackClick={noop}
      update={null}
      onDismissUpdate={noop}
    />
  </ConnectionStatusProvider>,
)

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function publish(results: Partial<HarnessResults>): void {
  window.__results = {
    pass: false,
    error: null,
    sheetsRead: 0,
    hoverRulesSeen: 0,
    buttonClasses: '',
    hits: [],
    ...results,
  }
}

// Properties that would make the logo look different under the cursor. A
// transform (the `active:scale-95` press feedback) is deliberately not here —
// it moves the logo, it does not recolour it.
const PAINT_PROPS = ['opacity', 'color', 'fill', 'filter']

/**
 * Every :hover rule in the loaded stylesheets that both matches one of `els`
 * (with the :hover stripped, which is how the rule would apply under the
 * cursor) and sets a paint property. Recurses into @media/@supports, since
 * Tailwind wraps hover utilities in `@media (hover: hover)`.
 */
function hoverPaintRules(els: Element[]): { hits: HoverHit[]; sheetsRead: number; hoverRulesSeen: number } {
  const hits: HoverHit[] = []
  let sheetsRead = 0
  let hoverRulesSeen = 0

  // `parent` is the enclosing style rule's resolved selector, for CSS nesting.
  // Note a plain CSSStyleRule also has a `cssRules` (its nested rules), and an
  // empty CSSRuleList is truthy — so a rule is only *grouping* (@layer, @media,
  // @supports) when it has no selectorText of its own.
  const scan = (rules: CSSRuleList, parent: string): void => {
    for (const rule of Array.from(rules)) {
      const selector = (rule as CSSStyleRule).selectorText
      const nested = (rule as CSSGroupingRule).cssRules
      if (!selector) {
        if (nested) scan(nested, parent)
        continue
      }
      const resolved = parent
        ? (selector.includes('&') ? selector.replace(/&/g, parent) : `${parent} ${selector}`)
        : selector
      if (nested?.length) scan(nested, resolved)
      if (!resolved.includes(':hover')) continue
      hoverRulesSeen++
      // Strip the pseudo-class: what is left is the selector the element must
      // match for the rule to apply while the cursor is over it.
      const base = resolved.replace(/:hover/g, '')
      let matched: Element | undefined
      try {
        matched = els.find((el) => el.matches(base))
      } catch {
        continue // a selector this browser cannot parse in isolation
      }
      if (!matched) continue
      const style = (rule as CSSStyleRule).style
      for (const property of PAINT_PROPS) {
        const value = style.getPropertyValue(property)
        if (value) hits.push({ selector: resolved, property, value })
      }
    }
  }

  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList
    try {
      rules = sheet.cssRules
    } catch {
      continue // cross-origin / unreadable — counted by omission from sheetsRead
    }
    sheetsRead++
    scan(rules, '')
  }
  return { hits, sheetsRead, hoverRulesSeen }
}

async function run(): Promise<void> {
  const deadline = Date.now() + 5000
  let button: HTMLButtonElement | null = null
  while (!button && Date.now() < deadline) {
    await sleep(50)
    button = document.querySelector<HTMLButtonElement>('button[aria-label="Home"]')
  }
  if (!button) return publish({ error: 'no top bar home button (aria-label="Home") rendered' })
  const svg = button.querySelector('svg')
  if (!svg) return publish({ error: 'the home button renders no logo <svg>' })
  await document.fonts.ready
  await sleep(100)

  const { hits, sheetsRead, hoverRulesSeen } = hoverPaintRules([button, svg])

  // A stylesheet this harness could not read would make every assertion below
  // vacuously true, so prove the scan actually saw the app's hover utilities
  // before trusting an empty result.
  if (sheetsRead === 0) return publish({ error: 'no stylesheet was readable — the hover scan would pass vacuously' })
  if (hoverRulesSeen === 0) return publish({ error: 'the stylesheet contains no :hover rules at all — wrong sheet loaded?' })

  publish({
    pass: hits.length === 0,
    sheetsRead,
    hoverRulesSeen,
    buttonClasses: button.className,
    hits,
  })
}

run().catch((e) => publish({ error: String(e?.stack || e) }))
