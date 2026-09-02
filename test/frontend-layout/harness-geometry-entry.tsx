// Folder-screen geometry harness (LOCAL/dev-machine only — spawns a real Electron GUI process,
// like the agent-desktop frontend suite). Mounts the REAL <FolderView> inside the REAL app-shell
// wrappers and checks two invariants the eye caught before any test did:
//
//   1. A focusable control that is fully visible has at least `ring-2`'s worth of room inside
//      EVERY clipping ancestor, or its focus ring is shaved off by a scroll pane or an
//      `overflow-hidden` wrapper.
//   2. The filter row and the file rows share a right edge. They only do while the row lives
//      INSIDE the scroll pane: moved back outside it, the row spans the full column while the
//      rows stop short of the scrollbar and its gutter, and the column's right edge goes ragged.
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

    // The filter row's own right edge against the first file row's. Equal by construction while
    // both share the pane's content box; 27px apart the moment the row moves back outside it.
    const expand = controls.find((el) => el.tagName === 'BUTTON' && /expand|collapse/i.test(el.textContent ?? ''))
    const firstRow = controls.find((el) => el.className.includes('w-full text-left'))
    const ragged = expand && firstRow
      ? Math.round((firstRow.getBoundingClientRect().right - expand.getBoundingClientRect().right) * 10) / 10
      : null

    // And it has to hold that edge while the list moves under it. Scrolled 400px down, the row
    // must still sit at the top of the scrollport rather than travelling away with the rows.
    const pane = document.querySelector<HTMLElement>('main div[class*="overflow-y-auto"]')
    const sticky = document.querySelector<HTMLElement>('main div[class*="sticky"]')
    let stuckBy: number | null = null
    if (pane && sticky) {
      pane.scrollTop = 400
      void pane.offsetHeight
      stuckBy = Math.round((sticky.getBoundingClientRect().top - pane.getBoundingClientRect().top) * 10) / 10
      pane.scrollTop = 0
    }

    ;(window as unknown as { __results: unknown }).__results = {
      ring: RING,
      checked,
      skipped,
      offenders: offenders.slice(0, 12),
      ragged,
      stuckBy,
      pass: offenders.length === 0
        && ragged !== null && Math.abs(ragged) <= 1
        // 4px is the pane's own pt-1 of ring clearance; anything larger means it scrolled away.
        && stuckBy !== null && stuckBy <= 5,
    }
  }
  tick()
}

run()
