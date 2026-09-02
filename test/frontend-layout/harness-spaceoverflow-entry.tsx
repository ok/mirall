// Real-Chromium document-overflow harness for the SPACE screen (the FolderView scenario in
// harness-entry.tsx is its twin). Mounts the REAL <SpaceView> inside the REAL app-shell wrappers
// (root `min-h-screen` + `<main>` top-padding that, with the screen's
// `h-[calc(100vh-5rem-var(--banner-h))]`, sum to exactly 100vh) with enough folder shares and
// loose files to overflow the list, and asserts the DOCUMENT never becomes scrollable — the list
// pane scrolls, the window does not.
//
// `window.bridge` is installed by fake-bridge.js (a classic script loaded first in
// harness-spaceoverflow.html), so `ipc.ts` and every hook/component run unmodified.
import './harness-bootstrap.js'
import { createRoot } from 'react-dom/client'
import './../../src/renderer/i18n.js'
import { ToastProvider } from './../../src/renderer/components/toast/ToastProvider.js'
import { KeyboardProvider } from './../../src/renderer/keyboard/KeyboardProvider.js'
import SpaceView from './../../src/renderer/screens/SpaceView.js'
import { offenders, positioned, bodyChildren, containerMetrics, documentScrollable, ancestorChain } from './document-overflow.js'
import type { FileEntry, Share } from './../../src/renderer/types.js'

interface Phase {
  overflow: number
  scrollable: boolean
  paneScrollTop: number
}

interface HarnessResults {
  innerHeight: number
  shareCards: number
  paneScrolls: boolean
  rest: Phase | null
  scrolled: Phase | null
  worstOffenders: unknown
  chain: unknown
  worstMetrics: unknown
  worstPositioned: unknown
  worstBodyChildren: unknown
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

// The shape of the reported screen: several folder shares of my own, one owned by a peer, and a
// couple of loose files below them — more rows than the pane is tall.
const SHARE_NAMES = ['anon-avatars', 'Boiler Room Carl Cox in Ibiza', 'Boiler Room DJ Rush in Rotterdam', 'Boiler Room Monika Kruse in Berlin', 'empty folder']
const shares: Share[] = SHARE_NAMES.map((name, i) => ({
  id: `share-${i}`,
  type: 'owned-folder',
  name,
  owner: i === SHARE_NAMES.length - 1 ? OWNER_PK : SELF_PK,
  spaceId: SPACE_ID,
  createdAt: 0,
}))
const files: FileEntry[] = ['Bios-Ren7000.zip', 'Rack-Layout.pdf'].map((name, i) => ({
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

function phase(pane: HTMLElement): Phase {
  return {
    overflow: document.documentElement.scrollHeight - window.innerHeight,
    scrollable: documentScrollable(),
    paneScrollTop: Math.round(pane.scrollTop),
  }
}

function publish(results: Partial<HarnessResults> & { pass: boolean; error: string | null }): void {
  window.__results = {
    innerHeight: window.innerHeight,
    shareCards: shareCardCount(),
    paneScrolls: false,
    rest: null,
    scrolled: null,
    worstOffenders: offenders(window.innerHeight),
    chain: ancestorChain(listPane()),
    worstMetrics: containerMetrics(),
    worstPositioned: positioned(),
    worstBodyChildren: bodyChildren(),
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

  const rest = phase(pane)

  // Scroll the list to its end: the rows that were below the fold are the ones whose escaping
  // boxes (an overlay positioned against an ancestor outside the pane, say) land past the
  // viewport bottom and grow the document.
  const paneScrolls = pane.scrollHeight > pane.clientHeight + 1
  pane.scrollTop = pane.scrollHeight
  await sleep(200)
  const scrolled = phase(pane)

  const worstAt = rest.overflow >= scrolled.overflow ? rest : scrolled
  if (worstAt === rest) pane.scrollTop = 0
  await sleep(50)

  publish({
    paneScrolls,
    rest,
    scrolled,
    // The list must overflow for the scrolled measurement to mean anything, and neither phase
    // may leave the document scrollable.
    pass: paneScrolls && !rest.scrollable && !scrolled.scrollable,
    error: null,
  })
}

run()
