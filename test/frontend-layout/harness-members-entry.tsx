// Real-Chromium layout harness for the Members panel. Mounts the REAL
// <SpaceView> inside the REAL app-shell wrappers (root `min-h-screen` + `<main>`
// top-padding that, with the screen's `h-[calc(100vh-5rem-var(--banner-h))]`,
// sum to 100vh), expands the Members box, and measures whether the expanded card
// hugs its content (collapsing the empty space below it) for a small roster while
// still capping at the available height and scrolling internally for a large one.
//
// `window.bridge` is installed by fake-bridge.js (a classic script loaded first
// in harness-members.html), so `ipc.ts` and every hook/component run unmodified.
import './harness-bootstrap.js'
import { createRoot } from 'react-dom/client'
import i18n from './../../src/renderer/i18n.js'
import { ToastProvider } from './../../src/renderer/components/toast/ToastProvider.js'
import { KeyboardProvider } from './../../src/renderer/keyboard/KeyboardProvider.js'
import SpaceView from './../../src/renderer/screens/SpaceView.js'
import type { SpaceMember } from './../../src/renderer/types.js'

interface FakeDriver {
  SPACE_ID: string
  SHARE_ID: string
  OWNER_PK: string
  files: Array<{ relPath: string; size: number }>
  // The array space:members answers with — the harness grows it in place.
  members: SpaceMember[]
}

interface ReconcileEvent {
  type: 'event:reconcile'
  scope: { kind: string; spaceId: string }
}

interface PhaseMetrics {
  memberRows: number
  colHeight: number
  colBottom: number
  cardHeight: number
  cardBottom: number
  gapBelow: number
  scrollClientH: number
  scrollContentH: number
  scrollOverflow: boolean
}

interface HarnessResults {
  innerHeight: number
  few: PhaseMetrics | null
  many: PhaseMetrics | null
  fewOk: boolean
  manyOk: boolean
  pass: boolean
  error: string | null
}

declare global {
  interface Window {
    __fake: FakeDriver
    __fakeEmit: (event: ReconcileEvent) => void
    __results: HarnessResults
  }
}

const f = window.__fake

const container = document.getElementById('root') as HTMLElement
createRoot(container).render(
  <div className="min-h-screen bg-surface">
    <main className="pt-[calc(5rem+var(--banner-h,0px))]">
      <ToastProvider>
        <KeyboardProvider currentScreen="space-view" selectedSpaceId={f.SPACE_ID}>
          <SpaceView spaceId={f.SPACE_ID} onBack={() => {}} onManageStorage={() => {}} />
        </KeyboardProvider>
      </ToastProvider>
    </main>
  </div>,
)

// --- measurement -----------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// The Members card is the CollapsibleCard whose header label is the translated
// "Members" string (distinguishes it from the sibling File Storage card).
function membersCard(): HTMLElement | null {
  const title = i18n.t('space.members')
  for (const card of Array.from(document.querySelectorAll<HTMLElement>('div.rounded-2xl'))) {
    const header = card.querySelector('button[aria-expanded] span')
    if (header && header.textContent === title) return card
  }
  return null
}

// The stack/list toggle: "Show all" when collapsed, "Show less" when expanded.
// Matched by its label rather than by the shape of its attributes — it carries
// aria-expanded of its own (it is a disclosure), so "the button that isn't the
// card header" cannot be spelled as :not([aria-expanded]).
function toggleButton(card: HTMLElement): HTMLButtonElement | null {
  const labels = [i18n.t('space.showAllMembers'), i18n.t('space.showFewerMembers')]
  const buttons = Array.from(card.querySelectorAll<HTMLButtonElement>('button'))
  return buttons.find((b) => labels.includes((b.textContent ?? '').trim())) ?? null
}

function scrollRegion(card: HTMLElement): HTMLElement | null {
  return card.querySelector<HTMLElement>('[role="region"]')
}

function memberRowCount(card: HTMLElement): number {
  const region = scrollRegion(card)
  return region ? region.children.length : 0
}

function measure(card: HTMLElement): PhaseMetrics {
  const col = card.parentElement as HTMLElement
  const colR = col.getBoundingClientRect()
  const cardR = card.getBoundingClientRect()
  const region = scrollRegion(card)
  const scrollClientH = region ? region.clientHeight : 0
  const scrollContentH = region ? region.scrollHeight : 0
  return {
    memberRows: memberRowCount(card),
    colHeight: Math.round(colR.height),
    colBottom: Math.round(colR.bottom),
    cardHeight: Math.round(cardR.height),
    cardBottom: Math.round(cardR.bottom),
    gapBelow: Math.round(colR.bottom - cardR.bottom),
    scrollClientH,
    scrollContentH,
    scrollOverflow: scrollContentH > scrollClientH + 1,
  }
}

function publishError(error: string): void {
  window.__results = {
    innerHeight: window.innerHeight,
    few: null,
    many: null,
    fewOk: false,
    manyOk: false,
    pass: false,
    error,
  }
}

async function run() {
  // Wait for the Members card and its collapsed "Show all" toggle to render.
  const deadline = Date.now() + 8000
  let card = membersCard()
  while ((!card || !toggleButton(card)) && Date.now() < deadline) {
    await sleep(50)
    card = membersCard()
  }
  if (!card) return publishError('Members card never rendered')
  const expandBtn = toggleButton(card)
  if (!expandBtn) return publishError('expand (Show all) button not found')

  // Expand into the fill layout — the surface of the bug.
  expandBtn.click()
  await sleep(150)
  card = membersCard()
  if (!card) return publishError('Members card vanished after expand')
  if (!scrollRegion(card)) return publishError('expanded members scroll region not found')

  const few = measure(card)

  // Grow the roster far past the available height to exercise cap + internal
  // scroll. useMembers re-reads space:members on a members-scoped reconcile hint —
  // it never folds a roster out of an event payload — so the growth has to land in
  // the fake bridge's roster first and be announced with a hint.
  for (let i = 0; i < 30; i++) {
    f.members.push({
      publicKey: `grown-${i}-`.padEnd(64, '0'),
      driveKey: 'd'.repeat(64),
      displayName: `Member ${i}`,
      online: i % 2 === 0,
      avatar: null,
    })
  }
  window.__fakeEmit({
    type: 'event:reconcile',
    scope: { kind: 'members', spaceId: f.SPACE_ID },
  })
  const growDeadline = Date.now() + 4000
  while (memberRowCount(card) < 24 && Date.now() < growDeadline) {
    await sleep(50)
    card = membersCard() ?? card
  }
  await sleep(150)
  const many = measure(card)

  // Few members: the expanded card must NOT stretch to the column bottom — there
  // must be real empty space below it, and the list must not be scrolling.
  const fewOk = few.gapBelow > 48 && few.scrollOverflow === false
  // Many members: the card caps at the column and the list scrolls internally.
  const manyOk = many.scrollOverflow === true && many.gapBelow <= 48

  window.__results = {
    innerHeight: window.innerHeight,
    few,
    many,
    fewOk,
    manyOk,
    pass: fewOk && manyOk,
    error: null,
  }
}

run()
