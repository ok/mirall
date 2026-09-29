// REGRESSION harness for the scroll-gutter render loop: a screen whose list pads itself when it
// overflows (useHasVerticalOverflow) must settle at every height. The padding changes the layout the
// overflow is measured on, and where the two states disagree the flag flipped on every commit until
// React stopped at its nested-update limit (#185) and the window went blank.
//
// Two parts. A synthetic consumer whose content fits exactly when padded and overflows when not,
// the worst case, must not crash the root. Then the REAL <SpacesScreen> with several spaces, in the
// real app-shell wrappers, is walked across its overflow boundary (1px steps, then 0.05px around the
// boundary, through --banner-h, which the screen's height already subtracts), counting the list's
// class changes and catching any uncaught render error.
import './harness-bootstrap.js'
import { createRoot } from 'react-dom/client'
import '../../src/renderer/platform/i18n.js'
import SpacesScreen from '../../src/renderer/screens/SpacesScreen.js'
import { useHasVerticalOverflow } from '../../src/renderer/hooks/useHasVerticalOverflow.js'

interface Flip {
  bannerH: number
  classChanges: number
  scrollH: number
  clientH: number
  padded: boolean
}

interface HarnessResults {
  pass: boolean
  error: string | null
  crash: string | null
  steps: number
  settledBoth: boolean
  flips: Flip[]
  oscillatorCrash: string | null
  oscillatorCommits: number
}

declare global {
  interface Window {
    __HARNESS_CFG?: { spaces?: object[] }
    __results: HarnessResults
  }
}

const NAMES = ['Aurora', 'Boiler Room', 'Camera roll', 'Design reviews', 'Family photos', 'Taxes 2026']
window.__HARNESS_CFG = {
  spaces: NAMES.map((name, i) => ({
    spaceId: `space-${i}`, name, icon: 'folder', topic: String(i).repeat(64),
    created: `2026-0${(i % 9) + 1}-01`, members: [], favorite: false, schemaVersion: 2,
  })),
}

let crash: string | null = null
let oscillatorCrash: string | null = null
let oscillatorCommits = 0
const noop = () => {}

// The worst consumer the hook can have: content that fits when padded and overflows when not, so
// every measurement contradicts the one before. The hook must survive it — flicker at worst, never
// a render loop that takes the window down.
function Oscillator() {
  const { ref, hasOverflow } = useHasVerticalOverflow<HTMLDivElement>()
  oscillatorCommits++
  return (
    <div ref={ref} data-oscillator className="overflow-y-auto" style={{ height: 100 }}>
      <div style={{ height: hasOverflow ? 60 : 140 }} />
    </div>
  )
}

const oscillatorHost = document.createElement('div')
document.body.appendChild(oscillatorHost)
createRoot(oscillatorHost, {
  onUncaughtError: (err) => { oscillatorCrash = err instanceof Error ? err.message : String(err) },
}).render(<Oscillator />)

createRoot(document.getElementById('root') as HTMLElement, {
  onUncaughtError: (err) => { crash = err instanceof Error ? err.message : String(err) },
}).render(
  <div className="min-h-screen bg-surface">
    <main className="pt-[calc(5rem+var(--banner-h,0px))]">
      <SpacesScreen onSelectSpace={noop} onShowCreate={noop} onShowJoin={noop} />
    </main>
  </div>,
)

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()))
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function publish(results: Partial<HarnessResults>): void {
  window.__results = { pass: false, error: null, crash, steps: 0, settledBoth: false, flips: [], oscillatorCrash, oscillatorCommits, ...results }
}

async function run(): Promise<void> {
  let list: HTMLElement | null = null
  for (let i = 0; i < 100 && !list; i++) {
    await sleep(50)
    list = document.querySelector<HTMLElement>('[role="list"]')
  }
  if (!list) return publish({ error: 'the space list never rendered', crash })

  let classChanges = 0
  new MutationObserver(() => { classChanges++ }).observe(list, { attributes: true, attributeFilter: ['class'] })

  const flips: Flip[] = []
  const seen = new Set<boolean>()
  let steps = 0
  let boundary: number | null = null
  let last: boolean | null = null

  // One step: move the screen height, let layout and effects settle, count the list's class changes.
  async function step(bannerH: number): Promise<boolean | null> {
    document.documentElement.style.setProperty('--banner-h', `${-bannerH}px`)
    classChanges = 0
    await frame()
    await frame()
    steps++
    const current = document.querySelector<HTMLElement>('[role="list"]')
    if (!current) return null
    const padded = current.className.includes('pr-4')
    seen.add(padded)
    if (classChanges > 1) {
      flips.push({ bannerH, classChanges, scrollH: current.scrollHeight, clientH: current.clientHeight, padded })
    }
    return padded
  }

  // Coarse: 1px at a time until the list stops overflowing. Fine: every 0.05px around that point,
  // where the padded and unpadded layouts differ by less than a pixel.
  for (let bannerH = 0; bannerH <= 900 && !crash && boundary === null; bannerH += 1) {
    const padded = await step(bannerH)
    if (last !== null && padded !== last) boundary = bannerH
    last = padded
  }
  if (boundary !== null) {
    for (let bannerH = boundary - 3; bannerH <= boundary + 3 && !crash; bannerH += 0.05) {
      await step(Math.round(bannerH * 100) / 100)
    }
  }
  publish({
    pass: !crash && !oscillatorCrash && flips.length === 0 && seen.size === 2,
    crash, oscillatorCrash, oscillatorCommits, steps, settledBoth: seen.size === 2, flips: flips.slice(0, 10),
  })
}

run().catch((err: Error) => publish({ error: err.message }))
