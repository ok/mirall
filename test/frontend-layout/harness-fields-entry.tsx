// Field contrast harness. Every place the user types meets the contrast floors in both themes: a
// placeholder clears 4.5:1 on its field, error text 4.5:1 on its ground, a field stands apart from
// the card it sits on, and a switch reads at 3:1 whether it is on or off.
//
// Mounts the REAL <TextField> on a modal panel and on a card, <SearchField>, <PathRow>, <RestoreProgress>,
// <ListControlsRow>, <Toggle>, <Account> and <OnboardingScreen> on the grounds they ship on, and measures painted colour: every computed colour
// is composited onto a canvas over the backgrounds behind it, so an alpha utility is judged as it is
// seen. The two name fields also have to resolve their description to their help and count, which
// the AX tree the frontend scenarios read does not expose.
import './harness-bootstrap.js'
import { createRoot } from 'react-dom/client'
import '../../src/renderer/platform/i18n.js'
import TextField, { fieldSurface } from '../../src/renderer/components/primitives/TextField.js'
import Toggle from '../../src/renderer/components/primitives/Toggle.js'
import { FieldGround } from '../../src/renderer/components/primitives/FieldGround.js'
import SearchField from '../../src/renderer/components/primitives/SearchField.js'
import PathRow from '../../src/renderer/components/path/PathRow.js'
import ListControlsRow from '../../src/renderer/components/listing/ListControlsRow.js'
import RestoreProgress from '../../src/renderer/components/backup/RestoreProgress.js'
import Account from '../../src/renderer/screens/AccountScreen.js'
import OnboardingScreen from '../../src/renderer/screens/OnboardingScreen.js'
import { ToastProvider } from '../../src/renderer/components/toast/ToastProvider.js'
import { KeyboardProvider } from '../../src/renderer/keyboard/KeyboardProvider.js'
import { ConnectionStatusProvider } from '../../src/renderer/hooks/useConnectionStatus.js'
import { RESTORE_VERDICT } from '../../src/shared/contract/restore-verdict.js'
import type { RestoreHoldView } from '../../src/renderer/model/restore-hold-view.js'
import type { Profile } from '../../src/renderer/types/types.js'

interface ThemeResult {
  theme: 'light' | 'dark'
  ratios: Record<string, number>
  fieldFill: string
  placeholder: string
  value: string
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

const HOLD: RestoreHoldView = {
  active: true,
  source: 'backup',
  progress: { verdict: RESTORE_VERDICT.NO_HOLDER, length: 0, target: 0, released: false },
  heldSpaceIds: [],
  canWriteProfile: false,
  canShareIn: () => false,
}

const PROFILE = { displayName: 'You', avatar: null } as Profile
const resolves = () => Promise.resolve()

createRoot(document.getElementById('root') as HTMLElement).render(
  <div className="bg-surface p-6 space-y-6">
    {/* A modal panel and the ground Modal gives its fields. */}
    <div data-probe="panel" className="glass-modal w-full max-w-xl p-10 space-y-6">
      <FieldGround fill="low">
        <div data-probe="modal-field">
          <TextField id="modal-field" label="Name" placeholder="A placeholder" value="" onChange={noop} />
        </div>
        <div data-probe="modal-textarea">
          <textarea aria-label="Message" placeholder="A placeholder" className={`${fieldSurface('low')} h-32 resize-none`} />
        </div>
      </FieldGround>
    </div>
    <div data-probe="card-field" className="bg-surface-container-low rounded-xl p-6">
      <TextField id="card-field" label="Name" placeholder="A placeholder" value="" onChange={noop} error="That did not work" />
    </div>
    <div data-probe="card-search" className="bg-surface-container-low rounded-xl p-6">
      <SearchField label="Search" placeholder="A placeholder" value="" onChange={noop} />
    </div>
    <div data-probe="card-path" className="bg-surface-container-low rounded-xl p-6">
      <PathRow path="/Users/you/Downloads" />
    </div>
    <div data-probe="restore">
      <RestoreProgress hold={HOLD} />
    </div>
    <div data-probe="filter">
      <ListControlsRow value="" onChange={noop} matched={null} total={0} filterLabel="Filter files" showExpand={false} />
    </div>
    <div className="bg-surface-container-low rounded-xl row-group">
      <div data-probe="toggle-off"><Toggle label="Off" checked={false} onChange={noop} /></div>
      <div data-probe="toggle-on"><Toggle label="On" checked onChange={noop} /></div>
    </div>
    <ToastProvider>
      <ConnectionStatusProvider>
        <KeyboardProvider currentScreen="account" selectedSpaceId={null}>
          <div data-probe="account">
            <Account profile={PROFILE} onSave={resolves} onBack={noop} onOpenNetworkStatus={noop} onOpenActivityLog={noop} onOpenBackup={noop} onOpenAbout={noop} onFeedback={noop} />
          </div>
          <div data-probe="onboarding">
            <OnboardingScreen onComplete={resolves} />
          </div>
        </KeyboardProvider>
      </ConnectionStatusProvider>
    </ToastProvider>
  </div>,
)

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function publish(results: Partial<HarnessResults>): void {
  window.__results = { pass: false, error: null, themes: [], failures: [], ...results }
}

type Rgb = [number, number, number]

const canvas = document.createElement('canvas')
canvas.width = 1
canvas.height = 1
const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D

// Paints each colour in order over the last, and reads back the sRGB pixel the eye would see.
function paint(layers: string[]): Rgb {
  ctx.globalCompositeOperation = 'source-over'
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, 1, 1)
  for (const c of layers) {
    ctx.fillStyle = c
    ctx.fillRect(0, 0, 1, 1)
  }
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
  return [r, g, b]
}

const lin = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
const lum = ([r, g, b]: Rgb) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
const contrast = (a: Rgb, b: Rgb) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }

// Every background from the root down to `el`, outermost first: what is painted behind it.
function grounds(el: Element): string[] {
  const out: string[] = []
  for (let n: Element | null = el; n; n = n.parentElement) out.unshift(getComputedStyle(n).backgroundColor)
  return out
}

const bg = (el: Element) => paint(grounds(el))
const over = (color: string, el: Element) => paint([...grounds(el), color])

function q(selector: string): Element {
  const el = document.querySelector(selector)
  if (!el) throw new Error(`missing ${selector}`)
  return el
}

const field = (probe: string) => q(`[data-probe="${probe}"] input:not([type="file"]), [data-probe="${probe}"] textarea`)
const track = (probe: string) => q(`[data-probe="${probe}"] [role="switch"] > span[aria-hidden="true"]`)
const knob = (probe: string) => q(`[data-probe="${probe}"] [role="switch"] > span[aria-hidden="true"] > span`)

const placeholderColor = (el: Element) => getComputedStyle(el, '::placeholder').color
const placeholderContrast = (probe: string) => {
  const el = field(probe)
  return contrast(over(placeholderColor(el), el), bg(el))
}
const textContrast = (selector: string) => {
  const el = q(selector)
  return contrast(over(getComputedStyle(el).color, el), bg(el))
}

// The text a screen reader reads after the field's name: every element its aria-describedby names.
function description(el: Element): string {
  const ids = (el.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean)
  return ids.map((id) => document.getElementById(id)?.textContent ?? `<missing #${id}>`).join(' ')
}

function within(inner: Element, outer: Element): boolean {
  const a = inner.getBoundingClientRect()
  const b = outer.getBoundingClientRect()
  return a.left >= b.left && a.right <= b.right && a.top >= b.top && a.bottom <= b.bottom
}

function measure(theme: 'light' | 'dark', failures: string[]): ThemeResult {
  const ratios: Record<string, number> = {}
  const need = (name: string, c: number, floor: number) => {
    ratios[name] = Number(c.toFixed(2))
    if (c < floor) failures.push(`${theme}: ${name} = ${c.toFixed(2)}:1 (< ${floor})`)
  }

  need('modal field placeholder', placeholderContrast('modal-field'), 4.5)
  need('textarea placeholder', placeholderContrast('modal-textarea'), 4.5)
  need('card field placeholder', placeholderContrast('card-field'), 4.5)
  need('onboarding name placeholder', placeholderContrast('onboarding'), 4.5)
  need('restore field placeholder', placeholderContrast('restore'), 4.5)
  need('filter placeholder', placeholderContrast('filter'), 4.5)
  need('card search placeholder', placeholderContrast('card-search'), 4.5)
  need('card field error text', textContrast('[data-probe="card-field"] [role="alert"]'), 4.5)
  need('card field vs its card', contrast(bg(field('card-field')), bg(field('card-field').parentElement as Element)), 1.1)
  need('restore invite field vs its card', contrast(bg(field('restore')), bg(field('restore').parentElement as Element)), 1.1)
  need('modal field vs its panel', contrast(bg(field('modal-field')), bg(q('[data-probe="panel"]'))), 1.1)
  need('card search vs its card', contrast(bg(field('card-search')), bg(q('[data-probe="card-search"]'))), 1.1)
  need('card path vs its card', contrast(bg(q('[data-probe="card-path"] .rounded-xl')), bg(q('[data-probe="card-path"]'))), 1.1)
  need('account name field vs its card', contrast(bg(q('#account-display-name')), bg(q('#account-display-name').parentElement as Element)), 1.1)
  need('off switch outline', contrast(over(getComputedStyle(track('toggle-off')).borderTopColor, track('toggle-off')), bg(track('toggle-off'))), 3)
  need('off switch knob', contrast(bg(knob('toggle-off')), bg(track('toggle-off'))), 3)
  need('on switch track', contrast(bg(track('toggle-on')), bg(track('toggle-on').parentElement as Element)), 3)
  need('on switch knob', contrast(bg(knob('toggle-on')), bg(track('toggle-on'))), 3)

  for (const probe of ['toggle-off', 'toggle-on']) {
    if (!within(knob(probe), track(probe))) failures.push(`${theme}: the ${probe} knob leaves its track`)
  }

  const input = field('modal-field')
  const placeholder = placeholderColor(input)
  const value = getComputedStyle(input).color
  if (placeholder === value) failures.push(`${theme}: the placeholder colour ${placeholder} is the value colour, so it was never read`)
  return { theme, ratios, fieldFill: getComputedStyle(input).backgroundColor, placeholder, value }
}

async function run(): Promise<void> {
  const deadline = Date.now() + 5000
  const ready = () => ['restore-invite', 'account-display-name', 'display-name'].every((id) => document.getElementById(id))
  while (!ready() && Date.now() < deadline) await sleep(50)
  if (!ready()) return publish({ error: 'a field did not render' })

  const failures: string[] = []
  const said = (selector: string, parts: string[]) => {
    const text = description(q(selector))
    for (const part of parts) if (!text.includes(part)) failures.push(`${selector} is not described by "${part}" (reads "${text}")`)
  }
  said('#account-display-name', ['3/80 characters'])
  said('#display-name', ['This is how your team and friends will see you.', '0/80 characters'])

  const themes: ThemeResult[] = []
  for (const theme of ['light', 'dark'] as const) {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    // The fields carry `transition-all`: measured too early they read a blend of the two themes.
    await sleep(600)
    themes.push(measure(theme, failures))
  }
  document.documentElement.classList.remove('dark')

  // Light and dark must differ, or the theme switch never reached the tokens and every ratio above
  // was measured twice in one theme.
  if (themes[0].fieldFill === themes[1].fieldFill) failures.push('the theme switch did not change the field fill')

  publish({ pass: failures.length === 0, themes, failures })
}

run().catch((e: Error) => publish({ error: String(e?.stack || e) }))
