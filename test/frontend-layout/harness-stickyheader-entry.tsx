// Real-Chromium test for the SPACE screen's pinned section headers ("Folders Shared" /
// "Files Shared"). They are `position: sticky; top: 0` inside the list pane, and Chromium pins a
// sticky box at the scrollport top PLUS the scroll container's own `padding-top` — so a pane with
// any `pt-*` leaves a band above the pinned header in which the rows scrolling behind it stay
// visible. That band is 4px of a card sliced off mid-row, right above the heading; nothing in the
// AX tree can see it, which is why it lives here rather than in `test/frontend/`.
//
// Mounts the REAL <SpaceView> inside the REAL app-shell wrappers with more rows than the pane is
// tall, scrolls the list so rows sit behind each header in turn, and asserts the band is empty.
//
// `window.bridge` is installed by fake-bridge.js (a classic script loaded first in
// harness-stickyheader.html), so `ipc.ts` and every hook/component run unmodified.
import './harness-bootstrap.js'
import { createRoot } from 'react-dom/client'
import './../../src/renderer/i18n.js'
import { ToastProvider } from './../../src/renderer/components/toast/ToastProvider.js'
import { KeyboardProvider } from './../../src/renderer/keyboard/KeyboardProvider.js'
import SpaceView from './../../src/renderer/screens/SpaceView.js'
import type { FileEntry, Share } from './../../src/renderer/types.js'

interface HeaderMetrics {
  label: string
  /* Distance from the scrollport's top edge to the pinned header's top edge: the height of the
     band the header does not cover. */
  gap: number
  /* Tallest slice of a row left visible inside that band. */
  leak: number
  /* A row is actually passing behind this header — which is also what makes it pinned: a
     section's rows sit BELOW its header in flow, so they can only reach it once it stopped
     scrolling. A header still riding the flow has a large, meaningless gap. */
  rowsBehind: number
  pinned: boolean
}

interface Phase {
  paneScrollTop: number
  headers: HeaderMetrics[]
}

interface HarnessResults {
  innerHeight: number
  shareCards: number
  paneScrolls: boolean
  phases: Phase[]
  worstGap: number
  worstLeak: number
  headersPinned: number
  /* At rest, the room between the scrollport's top edge and the topmost focusable control —
     what the pane's removed `pt-1` used to buy. The header's own bottom padding covers it. */
  topControlClearance: number
  pass: boolean
  error: string | null
}

declare global {
  interface Window {
    __fake: { SPACE_ID: string; OWNER_PK: string; SELF_PK: string }
    __HARNESS_CFG?: { shares?: Share[]; files?: FileEntry[] }
    __results: HarnessResults
  }
}

const { SPACE_ID, OWNER_PK, SELF_PK } = window.__fake

// Enough folder shares and loose files that BOTH sections overflow the pane, so each header
// spends part of the scroll pinned with its own rows sliding behind it.
const SHARE_NAMES = [
  'Boiler Room Carl Cox in Ibiza',
  'Boiler Room DJ Rush in Rotterdam',
  'Boiler Room Monika Kruse in Berlin',
  'Boiler Room Amelie Lens in Antwerp',
  'anon-avatars',
]
const shares: Share[] = SHARE_NAMES.map((name, i) => ({
  id: `share-${i}`,
  type: 'owned-folder',
  name,
  owner: i === SHARE_NAMES.length - 1 ? OWNER_PK : SELF_PK,
  spaceId: SPACE_ID,
  createdAt: 0,
}))
const FILE_NAMES = [
  'Bios-Ren7000.zip', 'Rack-Layout.pdf', 'IMG_1995.pxd', 'set-notes.txt',
  'stage-plot.png', 'rider-2026.docx', 'mixdown-master.wav', 'cue-sheet.csv',
]
const files: FileEntry[] = FILE_NAMES.map((name, i) => ({
  path: '/' + name,
  size: 8_200_000 + i,
  hash: String(i).repeat(64),
  owner: { displayName: 'You', publicKey: SELF_PK },
  driveKey: 'e'.repeat(64),
  localBytes: 8_200_000 + i,
  isAvailable: true,
  status: 'mine',
}))
window.__HARNESS_CFG = { shares, files }

createRoot(document.getElementById('root') as HTMLElement).render(
  <div className="min-h-screen bg-surface">
    <main className="pt-[calc(5rem+var(--banner-h,0px))]">
      <ToastProvider>
        <KeyboardProvider currentScreen="space-view" selectedSpaceId={SPACE_ID}>
          <SpaceView spaceId={SPACE_ID} onBack={() => {}} onManageStorage={() => {}} />
        </KeyboardProvider>
      </ToastProvider>
    </main>
  </div>,
)

// --- measurement -----------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// ShareCard's root — the only `group isolate` box on the screen.
function shareCardCount(): number {
  return document.querySelectorAll('div.group.isolate').length
}

// The list pane: the screen's own scroller, found by what it does rather than by a class chain.
// It is the first `overflow-y: auto` box in document order — the list sits ahead of the sidebar.
function listPane(): HTMLElement | null {
  const main = document.querySelector('main')
  if (!main) return null
  for (const el of Array.from(main.querySelectorAll<HTMLElement>('div'))) {
    if (getComputedStyle(el).overflowY === 'auto') return el
  }
  return null
}

// Pinned headers, found by computed position rather than class, each paired with the rows of its
// own section (the sibling grid) — those are the boxes that scroll behind it.
function stickyHeaders(pane: HTMLElement): { el: HTMLElement; rows: HTMLElement[] }[] {
  return Array.from(pane.querySelectorAll<HTMLElement>('div'))
    .filter((el) => getComputedStyle(el).position === 'sticky')
    .map((el) => ({
      el,
      rows: Array.from(el.parentElement?.querySelectorAll<HTMLElement>(':scope > div.grid > *') ?? []),
    }))
}

const overlap = (aTop: number, aBottom: number, bTop: number, bBottom: number) =>
  Math.max(0, Math.min(aBottom, bBottom) - Math.max(aTop, bTop))

// `focus-visible:ring-2` paints 2px outside the border box, so a control that close to a clipping
// edge loses part of its ring. Measured at rest, where the pane's top edge is the clipping one.
const RING = 2

function topControlClearance(pane: HTMLElement): number {
  const portTop = pane.getBoundingClientRect().top + pane.clientTop
  let closest = Infinity
  for (const el of Array.from(pane.querySelectorAll<HTMLElement>('button, a[href], [tabindex]'))) {
    const r = el.getBoundingClientRect()
    if (r.height === 0 || r.top < portTop) continue
    closest = Math.min(closest, r.top - portTop)
  }
  return closest === Infinity ? -1 : Math.round(closest * 100) / 100
}

function measure(pane: HTMLElement): Phase {
  // The scrollport is the pane's PADDING box: `overflow` clips there, so anything inside the
  // pane's own padding is on screen.
  const portTop = pane.getBoundingClientRect().top + pane.clientTop
  const headers = stickyHeaders(pane).map(({ el, rows }) => {
    const box = el.getBoundingClientRect()
    const gap = Math.max(0, box.top - portTop)
    let leak = 0
    let rowsBehind = 0
    for (const row of rows) {
      const r = row.getBoundingClientRect()
      leak = Math.max(leak, overlap(portTop, box.top, r.top, r.bottom))
      if (overlap(box.top, box.bottom, r.top, r.bottom) > 0) rowsBehind++
    }
    return {
      label: (el.textContent || '').trim().slice(0, 40),
      gap: Math.round(gap * 100) / 100,
      leak: Math.round(leak * 100) / 100,
      rowsBehind,
      pinned: rowsBehind > 0,
    }
  })
  return { paneScrollTop: Math.round(pane.scrollTop), headers }
}

function publish(results: Partial<HarnessResults> & { pass: boolean; error: string | null }): void {
  window.__results = {
    innerHeight: window.innerHeight,
    shareCards: shareCardCount(),
    paneScrolls: false,
    phases: [],
    worstGap: 0,
    worstLeak: 0,
    headersPinned: 0,
    topControlClearance: -1,
    ...results,
  }
}

async function run() {
  const deadline = Date.now() + 8000
  while (shareCardCount() < shares.length && Date.now() < deadline) await sleep(50)
  if (shareCardCount() < shares.length) return publish({ pass: false, error: 'share cards never rendered' })
  await sleep(200)

  const pane = listPane()
  if (!pane) return publish({ pass: false, error: 'list scroll pane not found' })
  const paneScrolls = pane.scrollHeight > pane.clientHeight + 1
  const clearance = topControlClearance(pane)

  // Three stops: the folders header just pinned, deep into the folder list, and the end of the
  // pane where the files header carries the same job.
  const phases: Phase[] = []
  for (const top of [140, 320, pane.scrollHeight]) {
    pane.scrollTop = top
    await sleep(120)
    phases.push(measure(pane))
  }
  pane.scrollTop = 0

  const pinned = phases.flatMap((p) => p.headers).filter((h) => h.pinned)
  const worstGap = pinned.reduce((m, h) => Math.max(m, h.gap), 0)
  const worstLeak = pinned.reduce((m, h) => Math.max(m, h.leak), 0)
  const headersPinned = new Set(pinned.map((h) => h.label)).size

  publish({
    paneScrolls,
    phases,
    worstGap,
    worstLeak,
    headersPinned,
    topControlClearance: clearance,
    // A pinned header must sit flush on the scrollport with nothing of a row showing above it.
    // Both section headers have to reach that state for the run to prove anything — a fixture
    // whose sections stopped overflowing would otherwise pass by measuring nothing. Sub-pixel
    // slack because a fractional device-pixel ratio rounds rects.
    pass: paneScrolls && headersPinned >= 2 && worstGap <= 0.5 && worstLeak <= 0.5 && clearance >= RING,
    error: null,
  })
}

run()
