// Grouped-row focus harness (LOCAL/dev-machine only — spawns a real Electron GUI process, like the
// agent-desktop frontend suite). Mounts the REAL settings screens and an ActionRow group, focuses
// every full-width row of a rounded, clipping group, and asserts the focus treatment fits the card:
// the ring is inset (an outside ring is clipped away by the group), a row flush against the group's
// top or bottom edge carries the group's corner radius there (a square ring is shaved by the
// rounded clip), and the focused row is tinted.
//
// Programmatic focus with no prior pointer input matches :focus-visible in Chromium, so the ring
// really paints; the harness checks that it does, or it proves nothing.
import './harness-bootstrap.js'
import { createRoot } from 'react-dom/client'
import '../../src/renderer/platform/i18n.js'
import { ToastProvider } from '../../src/renderer/components/toast/ToastProvider.js'
import ActionRow, { LinkRow, ROW_GROUP } from '../../src/renderer/components/layout/ActionRow.js'
import Settings from '../../src/renderer/screens/settings/SettingsScreen.js'
import NotificationSettings from '../../src/renderer/screens/settings/NotificationSettings.js'
import AppearanceSettings from '../../src/renderer/screens/settings/AppearanceSettings.js'

interface Offender { row: string; problem: string }

interface HarnessResults {
  checked: number
  edgeRows: number
  offenders: Offender[]
  pass: boolean
  error: string | null
}

declare global {
  interface Window { __results: HarnessResults }
}

const noop = () => {}

createRoot(document.getElementById('root') as HTMLElement).render(
  <div className="min-h-screen bg-surface">
    <main>
      <ToastProvider>
        <Settings onBack={noop} onNavigate={noop} />
        <NotificationSettings onBack={noop} />
        <AppearanceSettings onBack={noop} />
        <div className="max-w-2xl mx-auto p-8">
          <div className={ROW_GROUP}>
            <ActionRow icon="history" label="Activity log" desc="Recording" onClick={noop} />
            <LinkRow icon="code" label="Source" desc="mirall.app" href="https://mirall.app" />
          </div>
        </div>
      </ToastProvider>
    </main>
  </div>,
)

// Transitions off: the harness reads settled colours, not a frame mid-fade.
const still = document.createElement('style')
still.textContent = '*, *::before, *::after { transition: none !important; }'
document.head.appendChild(still)

const EPS = 0.5

function roundedClipper(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const s = getComputedStyle(p)
    if (s.overflowX === 'visible' && s.overflowY === 'visible') continue
    return parseFloat(s.borderTopLeftRadius) > 0 ? p : null
  }
  return null
}

function nameOf(el: HTMLElement): string {
  return (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40)
}

function measure(): HarnessResults {
  const offenders: Offender[] = []
  let checked = 0
  let edgeRows = 0
  const rows = Array.from(document.querySelectorAll<HTMLElement>('main button:not(:disabled), main a[href]'))
  for (const row of rows) {
    const card = roundedClipper(row)
    if (!card) continue
    row.scrollIntoView({ block: 'center' })
    const r = row.getBoundingClientRect()
    const c = card.getBoundingClientRect()
    if (Math.abs(r.width - c.width) > EPS) continue
    checked++
    const name = nameOf(row)
    const resting = getComputedStyle(row).backgroundColor
    row.focus()
    if (!row.matches(':focus-visible')) {
      offenders.push({ row: name, problem: 'focus() did not match :focus-visible' })
      continue
    }
    const s = getComputedStyle(row)
    if (!s.boxShadow.includes('inset')) offenders.push({ row: name, problem: `ring not inset (${s.boxShadow})` })
    if (s.backgroundColor === resting) offenders.push({ row: name, problem: 'focused row is not tinted' })
    const radius = getComputedStyle(card).borderTopLeftRadius
    const corners: Array<[boolean, string, string[]]> = [
      [Math.abs(r.top - c.top) < EPS, 'top', [s.borderTopLeftRadius, s.borderTopRightRadius]],
      [Math.abs(r.bottom - c.bottom) < EPS, 'bottom', [s.borderBottomLeftRadius, s.borderBottomRightRadius]],
    ]
    for (const [flush, edge, radii] of corners) {
      if (!flush) continue
      edgeRows++
      if (radii.some((v) => v !== radius)) offenders.push({ row: name, problem: `${edge} corners ${radii.join('/')} ≠ group ${radius}` })
    }
    row.blur()
  }
  return { checked, edgeRows, offenders, pass: offenders.length === 0, error: null }
}

function run() {
  const start = Date.now()
  const tick = () => {
    const switches = document.querySelectorAll('main [role="switch"]:not(:disabled)').length
    if ((switches < 8 || !document.hasFocus()) && Date.now() - start < 15000) return void setTimeout(tick, 100)
    try {
      window.__results = measure()
    } catch (err) {
      window.__results = { checked: 0, edgeRows: 0, offenders: [], pass: false, error: String(err) }
    }
  }
  tick()
}

run()
