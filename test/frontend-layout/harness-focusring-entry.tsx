// Focus-ring clearance harness (LOCAL/dev-machine only — spawns a real Electron GUI process, like
// the agent-desktop frontend suite). Mounts the REAL <FolderView> inside the REAL app-shell
// wrappers and checks a geometric invariant the eye caught before any test did: a focusable
// control that is fully visible must have at least `ring-2`'s worth of room inside EVERY clipping
// ancestor, or its focus ring is shaved off by a scroll pane / an `overflow-hidden` wrapper.
//
// Geometry only: `focus-visible:ring-2` is a box-shadow painted OUTSIDE the border box, so the
// room either exists or it doesn't — the ring never has to paint, and nothing has to fake
// :focus-visible.
import './harness-bootstrap.js'
import { createRoot } from 'react-dom/client'
import './../../src/renderer/i18n.js'
import { ToastProvider } from './../../src/renderer/components/toast/ToastProvider.js'
import FolderView from './../../src/renderer/screens/FolderView.js'

const RING = 2

const f = (window as unknown as { __fake: { SPACE_ID: string; SHARE_ID: string; OWNER_PK: string } }).__fake

const share = {
  id: f.SHARE_ID,
  type: 'owned-folder',
  name: '[CLV009] - Vhinz - Belvedere Flac',
  owner: f.OWNER_PK,
  spaceId: f.SPACE_ID,
  createdAt: 0,
  role: 'mirrored',
} as unknown as Parameters<typeof FolderView>[0]['share']

createRoot(document.getElementById('root') as HTMLElement).render(
  <div className="min-h-screen bg-surface">
    <main className="pt-[calc(5rem+var(--banner-h,0px))]">
      <ToastProvider>
        <FolderView spaceId={f.SPACE_ID} share={share} onBack={() => {}} />
      </ToastProvider>
    </main>
  </div>,
)

// --- measurement -----------------------------------------------------------

type Side = 'left' | 'top' | 'right' | 'bottom'
interface Offender { tag: string; cls: string; side: Side; room: number; clipper: string }

// Every ancestor that clips. An `overflow-y-auto` pane clips BOTH axes: per CSS, a `visible` on
// one axis computes to `auto` when the other is not `visible`, which is why a horizontal ring
// disappears into a vertically-scrolling list.
function clippers(el: Element): HTMLElement[] {
  const out: HTMLElement[] = []
  for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
    const s = getComputedStyle(p)
    if (s.overflowX !== 'visible' || s.overflowY !== 'visible') out.push(p)
  }
  return out
}

// Room between `el` and each clipper's PADDING box — what actually clips, and `client*` keeps a
// scrollbar from reading as missing room.
function clearance(el: HTMLElement): { room: Record<Side, number>; by: Partial<Record<Side, string>> } {
  const r = el.getBoundingClientRect()
  const room: Record<Side, number> = { left: Infinity, top: Infinity, right: Infinity, bottom: Infinity }
  const by: Partial<Record<Side, string>> = {}
  for (const p of clippers(el)) {
    const pr = p.getBoundingClientRect()
    const left = pr.left + p.clientLeft
    const top = pr.top + p.clientTop
    const here: Record<Side, number> = {
      left: r.left - left,
      top: r.top - top,
      right: left + p.clientWidth - r.right,
      bottom: top + p.clientHeight - r.bottom,
    }
    for (const side of ['left', 'top', 'right', 'bottom'] as Side[]) {
      if (here[side] < room[side]) {
        room[side] = here[side]
        by[side] = `${p.tagName.toLowerCase()}.${String(p.className || '').slice(0, 60)}`
      }
    }
  }
  return { room, by }
}

function run() {
  const start = Date.now()
  const tick = () => {
    const rows = document.querySelectorAll('main button').length
    if (rows < 5 && Date.now() - start < 15000) return void setTimeout(tick, 100)

    const controls = Array.from(document.querySelectorAll<HTMLElement>('main button, main input, main a[href]'))
    const offenders: Offender[] = []
    let checked = 0
    let skipped = 0
    for (const el of controls) {
      const r = el.getBoundingClientRect()
      if (r.width < 4 || r.height < 4) { skipped++; continue }          // sr-only spans and the like
      const { room, by } = clearance(el)
      const sides = ['left', 'top', 'right', 'bottom'] as Side[]
      // A control scrolled out of its pane is legitimately clipped; only a control that is fully
      // inside every clipper is making a claim about its ring.
      if (sides.some((s) => room[s] < 0)) { skipped++; continue }
      checked++
      for (const side of sides) {
        if (room[side] < RING) {
          offenders.push({
            tag: el.tagName.toLowerCase(),
            cls: String(el.className || '').slice(0, 70),
            side,
            room: Math.round(room[side] * 10) / 10,
            clipper: by[side] ?? '',
          })
        }
      }
    }

    ;(window as unknown as { __results: unknown }).__results = {
      ring: RING,
      checked,
      skipped,
      offenders: offenders.slice(0, 12),
      pass: offenders.length === 0,
    }
  }
  tick()
}

run()
