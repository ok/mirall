// Segmented-control width-stability harness (LOCAL/dev-machine only — spawns a real Electron GUI
// process, like the agent-desktop frontend suite). Mounts the REAL <SegmentedControl> with the
// shipped label sets and clicks through every segment, measuring the track after each press.
//
// The bug this pins: the selected segment paints `font-semibold` and the rest `font-medium`, so a
// segment sized to the weight it is currently painting made the whole track resize on every click
// — one label widened, its neighbour narrowed, and the pill jittered under the pointer. Only real
// Chromium with the real font can measure that; jsdom has no glyph widths, and the AX tree the
// agent-desktop suite drives has no geometry at all.
//
// It measures the SETTLED state (the track carries `transition-all`, and font-weight is an
// animatable property), so it asserts where the layout comes to rest, not a frame mid-transition.
import './harness-bootstrap.js'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import './../../src/renderer/i18n.js'
import type { IconName } from './../../src/renderer/components/primitives/Icon.js'
import SegmentedControl, { Segment } from './../../src/renderer/components/primitives/SegmentedControl.js'

// The three shapes the app ships: text-only (Settings ▸ Network transfer caps), icon + text
// (Settings ▸ Appearance theme), and a wrapping multi-row group (the Activity Log category
// filters, here in a box narrow enough to force the second row).
const PRESETS = ['Unlimited', '1 MB/s', '5 MB/s', '25 MB/s', 'Custom']
const THEMES: Array<{ label: string; icon: IconName }> = [
  { label: 'Light', icon: 'light_mode' },
  { label: 'System', icon: 'computer' },
  { label: 'Dark', icon: 'dark_mode' },
]
const CATEGORIES = ['All', 'Members', 'Folders', 'Transfers', 'Spaces', 'System']

const SETTLE_MS = 220

interface GroupResult {
  id: string
  segments: number
  trackWidths: number[]
  trackHeights: number[]
  segmentWidths: string[]
  selectedWeights: string[]
  unselectedWeights: string[]
  stable: boolean
  weightMoves: boolean
}

interface HarnessResults {
  pass: boolean
  error: string | null
  groups: GroupResult[]
}

declare global {
  interface Window { __results: HarnessResults }
}

function Group({ id, labels, icons, wrap }: { id: string; labels: string[]; icons?: IconName[]; wrap?: boolean }) {
  const [selected, setSelected] = useState(0)
  // The shipped settings row: a label and the track in a `justify-between` flex line, so the
  // track is sized by its content. Dropped in a plain block it would fill the width and its
  // measurement would be a tautology.
  return (
    <div data-test={id} className="flex items-center justify-between gap-4">
      <p className="font-semibold text-accent">{id}</p>
      <SegmentedControl wrap={wrap}>
        {labels.map((label, i) => (
          <Segment
            key={label}
            label={label}
            icon={icons?.[i]}
            selected={i === selected}
            onSelect={() => setSelected(i)}
          />
        ))}
      </SegmentedControl>
    </div>
  )
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <div className="p-4 space-y-4 bg-surface">
    <Group id="presets" labels={PRESETS} />
    <Group id="theme" labels={THEMES.map((m) => m.label)} icons={THEMES.map((m) => m.icon)} />
    <div style={{ width: 320 }}>
      <Group id="categories" labels={CATEGORIES} wrap />
    </div>
  </div>,
)

// --- measurement -----------------------------------------------------------

const round = (n: number) => Math.round(n * 10) / 10
const settle = () => new Promise((r) => setTimeout(r, SETTLE_MS))

// The visible label copy — the ghost that reserves the selected width is its sibling, and it is
// deliberately semibold in every state, so reading it would prove nothing.
function labelWeight(button: HTMLElement): string {
  const visible = button.querySelector('span > span') as HTMLElement
  return getComputedStyle(visible).fontWeight
}

async function measure(id: string): Promise<GroupResult> {
  const scope = document.querySelector(`[data-test="${id}"]`) as HTMLElement
  const track = scope.querySelector('div') as HTMLElement
  const buttons = Array.from(scope.querySelectorAll('button'))
  const out: GroupResult = {
    id,
    segments: buttons.length,
    trackWidths: [],
    trackHeights: [],
    segmentWidths: [],
    selectedWeights: [],
    unselectedWeights: [],
    stable: false,
    weightMoves: false,
  }
  for (let i = 0; i < buttons.length; i++) {
    buttons[i].click()
    await settle()
    const r = track.getBoundingClientRect()
    out.trackWidths.push(round(r.width))
    out.trackHeights.push(round(r.height))
    out.segmentWidths.push(buttons.map((b) => round(b.getBoundingClientRect().width)).join('/'))
    out.selectedWeights.push(labelWeight(buttons[i]))
    out.unselectedWeights.push(labelWeight(buttons[(i + 1) % buttons.length]))
  }
  const same = (xs: Array<number | string>) => xs.every((x) => x === xs[0])
  // Height too: the wrapping group must not gain a row, which is the same failure one size up.
  out.stable = same(out.trackWidths) && same(out.trackHeights) && same(out.segmentWidths)
  // Guard against the cheap "fix" of dropping the weight change: the design says the pressed
  // segment reads bolder, and this harness only means something while that is still true.
  out.weightMoves = same(out.selectedWeights) && same(out.unselectedWeights) &&
    Number(out.selectedWeights[0]) > Number(out.unselectedWeights[0])
  return out
}

async function run() {
  try {
    // The webfont must be loaded before anything is measured — fallback metrics would make every
    // width agree with itself and the harness would pass on a lie.
    await document.fonts.ready
    const groups: GroupResult[] = []
    for (const id of ['presets', 'theme', 'categories']) groups.push(await measure(id))
    window.__results = {
      error: null,
      groups,
      pass: groups.every((g) => g.segments > 1 && g.stable && g.weightMoves),
    }
  } catch (e) {
    window.__results = { pass: false, error: String(e), groups: [] }
  }
}

void run()
