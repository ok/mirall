// Callout tone harness. A `note` callout sits on the text-field gray and a `warning` callout on the
// amber warning container, in both themes; neither is ever the `surface-container-high` plate, which
// in dark is lighter than the panel it sits on.
//
// Mounts the REAL <Callout> in both tones beside a REAL <TextField> on a modal panel, and compares
// computed backgrounds against probes painted with the tokens themselves.
import './harness-bootstrap.js'
import { createRoot } from 'react-dom/client'
import '../../src/renderer/platform/i18n.js'
import Callout from '../../src/renderer/components/primitives/Callout.js'
import TextField from '../../src/renderer/components/primitives/TextField.js'

interface ThemeResult {
  theme: 'light' | 'dark'
  field: string
  note: string
  warning: string
  warningContainer: string
  high: string
}

interface HarnessResults {
  pass: boolean
  error: string | null
  themes: ThemeResult[]
  failures: string[]
}

declare global {
  interface Window {
    __results: HarnessResults
  }
}

const noop = () => {}

createRoot(document.getElementById('root') as HTMLElement).render(
  <div className="glass-modal w-full max-w-xl p-10 space-y-6">
    <TextField id="callout-field" label="Field" value="" onChange={noop} />
    <div data-probe="note"><Callout tone="note" icon="warning" title="Keep this safe">Body</Callout></div>
    <div data-probe="warning"><Callout tone="warning" role="status">Body</Callout></div>
    <div data-probe="warning-container" className="bg-warning-container h-4" />
    <div data-probe="high" className="bg-surface-container-high h-4" />
  </div>,
)

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function publish(results: Partial<HarnessResults>): void {
  window.__results = { pass: false, error: null, themes: [], failures: [], ...results }
}

const bg = (el: Element | null) => (el ? getComputedStyle(el).backgroundColor : 'missing')
const calloutBox = (probe: string) => document.querySelector(`[data-probe="${probe}"] > div`)

function measure(theme: 'light' | 'dark'): ThemeResult {
  return {
    theme,
    field: bg(document.getElementById('callout-field')),
    note: bg(calloutBox('note')),
    warning: bg(calloutBox('warning')),
    warningContainer: bg(document.querySelector('[data-probe="warning-container"]')),
    high: bg(document.querySelector('[data-probe="high"]')),
  }
}

function check(m: ThemeResult): string[] {
  const out: string[] = []
  if (m.note !== m.field) out.push(`${m.theme}: note ${m.note} is not the field gray ${m.field}`)
  if (m.warning !== m.warningContainer) out.push(`${m.theme}: warning ${m.warning} is not warning-container ${m.warningContainer}`)
  if (m.note === m.high || m.warning === m.high) out.push(`${m.theme}: a callout is the surface-container-high plate ${m.high}`)
  return out
}

async function run(): Promise<void> {
  const deadline = Date.now() + 5000
  while (!calloutBox('warning') && Date.now() < deadline) await sleep(50)
  if (!calloutBox('warning')) return publish({ error: 'the callouts did not render' })

  const icons = document.querySelectorAll('[data-probe="note"] svg, [data-probe="warning"] svg')
  const failures = Array.from(icons).filter((svg) => svg.getAttribute('aria-hidden') !== 'true')
    .map(() => 'a callout icon is not aria-hidden')
  if (calloutBox('warning')?.getAttribute('role') !== 'status') failures.push('the warning callout lost role="status"')

  const themes: ThemeResult[] = []
  for (const theme of ['light', 'dark'] as const) {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    // The field carries `transition-all`: measured too early it reads a blend of the two themes.
    await sleep(600)
    const m = measure(theme)
    themes.push(m)
    failures.push(...check(m))
  }
  document.documentElement.classList.remove('dark')

  // Light and dark must differ, or the theme switch never reached the tokens and every comparison
  // above passed vacuously.
  if (themes[0].field === themes[1].field) failures.push('the theme switch did not change the field gray')

  publish({ pass: failures.length === 0, themes, failures })
}

run().catch((e) => publish({ error: String(e?.stack || e) }))
