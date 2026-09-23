// Real-Chromium ARIA harness for the member reach label. Mounts the REAL <SpaceScreen> inside the
// REAL app-shell wrappers, expands the Members box, and asserts the roster's three-state presence
// line: one relayed member beside a direct one, each carrying exactly ONE text node with the whole
// state in it, and the relayed row falling back to plain Online when the reach map loses the entry
// — re-rendered in place, not remounted.
import './harness-bootstrap.js'
import { createRoot } from 'react-dom/client'
import i18n from '../../src/renderer/platform/i18n.js'
import { ToastProvider } from './../../src/renderer/components/toast/ToastProvider.js'
import { KeyboardProvider } from './../../src/renderer/keyboard/KeyboardProvider.js'
import SpaceScreen from '../../src/renderer/screens/SpaceScreen.js'

interface FakeDriver {
  SPACE_ID: string
  OWNER_PK: string
  SELF_PK: string
}

interface ReconcileEvent {
  type: 'event:reconcile'
  scope: { kind: string; spaceId: string }
}

interface HarnessResults {
  labels: { relayedRow: string; directRow: string } | null
  oneNodePerRow: boolean
  dotsHidden: boolean
  fallsBackInPlace: boolean
  noLiveRegion: boolean
  pass: boolean
  error: string | null
}

declare global {
  interface Window {
    __fake: FakeDriver
    __fakeEmit: (event: ReconcileEvent) => void
    __HARNESS_CFG: { reach?: { members: Record<string, string> } }
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
          <SpaceScreen spaceId={f.SPACE_ID} onBack={() => {}} onManageStorage={() => {}} />
        </KeyboardProvider>
      </ToastProvider>
    </main>
  </div>,
)

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function membersCard(): HTMLElement | null {
  const title = i18n.t('space.members')
  for (const card of Array.from(document.querySelectorAll<HTMLElement>('div.rounded-2xl'))) {
    const header = card.querySelector('button[aria-expanded] span')
    if (header && header.textContent === title) return card
  }
  return null
}

function toggleButton(card: HTMLElement): HTMLButtonElement | null {
  const labels = [i18n.t('space.showAllMembers'), i18n.t('space.showFewerMembers')]
  const buttons = Array.from(card.querySelectorAll<HTMLButtonElement>('button'))
  return buttons.find((b) => labels.includes((b.textContent ?? '').trim())) ?? null
}

function rowFor(card: HTMLElement, displayName: string): HTMLElement | null {
  const region = card.querySelector<HTMLElement>('[role="region"]')
  if (!region) return null
  return Array.from(region.children).find(
    (row) => (row.textContent ?? '').includes(displayName),
  ) as HTMLElement | null
}

// The state is one string, so exactly one element in the row may carry it whole. Two would be the
// icon-plus-label shape assistive tech reads as two announcements.
function nodesCarrying(row: HTMLElement, text: string): number {
  return Array.from(row.querySelectorAll('*')).filter((el) => el.textContent === text).length
}

function presenceLineOf(row: HTMLElement): string {
  const line = row.querySelector<HTMLElement>('p.text-xs')
  return line ? (line.textContent ?? '') : ''
}

function publishError(error: string): void {
  window.__results = {
    labels: null,
    oneNodePerRow: false,
    dotsHidden: false,
    fallsBackInPlace: false,
    noLiveRegion: false,
    pass: false,
    error,
  }
}

async function run() {
  const deadline = Date.now() + 8000
  let card = membersCard()
  while ((!card || !toggleButton(card)) && Date.now() < deadline) {
    await sleep(50)
    card = membersCard()
  }
  if (!card) return publishError('Members card never rendered')
  const expandBtn = toggleButton(card)
  if (!expandBtn) return publishError('expand (Show all) button not found')
  expandBtn.click()
  await sleep(200)
  card = membersCard()
  if (!card) return publishError('Members card vanished after expand')

  const relayedRow = rowFor(card, 'Vhinz')
  const directRow = rowFor(card, 'You')
  if (!relayedRow || !directRow) return publishError('the two member rows did not render')

  const relayedLabel = i18n.t('member.relayed')
  const onlineLabel = i18n.t('member.online')
  const labels = { relayedRow: presenceLineOf(relayedRow), directRow: presenceLineOf(directRow) }

  const oneNodePerRow =
    labels.relayedRow === relayedLabel &&
    labels.directRow === onlineLabel &&
    labels.relayedRow !== labels.directRow &&
    nodesCarrying(relayedRow, relayedLabel) === 1 &&
    nodesCarrying(directRow, onlineLabel) === 1

  const dots = [relayedRow, directRow].map((row) => row.querySelector('div.rounded-full[aria-hidden]'))
  const dotsHidden = dots.every((dot) => dot?.getAttribute('aria-hidden') === 'true')

  // A presence flip is not announced — the roster owns no live region.
  const noLiveRegion = card.querySelector('[aria-live]') === null

  // Losing the reach entry must repaint the line, not rebuild the row: React keeps the avatar's DOM
  // node across a prop change, and a remount would drop scroll position and focus with it.
  const avatarBefore = relayedRow.querySelector('div.relative')
  window.__HARNESS_CFG.reach = { members: {} }
  window.__fakeEmit({ type: 'event:reconcile', scope: { kind: 'members', spaceId: f.SPACE_ID } })
  const flipDeadline = Date.now() + 4000
  let afterRow = rowFor(card, 'Vhinz')
  while (afterRow && presenceLineOf(afterRow) === relayedLabel && Date.now() < flipDeadline) {
    await sleep(50)
    afterRow = rowFor(card, 'Vhinz')
  }
  const fallsBackInPlace = !!afterRow &&
    presenceLineOf(afterRow) === onlineLabel &&
    afterRow.querySelector('div.relative') === avatarBefore

  window.__results = {
    labels,
    oneNodePerRow,
    dotsHidden,
    fallsBackInPlace,
    noLiveRegion,
    pass: oneNodePerRow && dotsHidden && fallsBackInPlace && noLiveRegion,
    error: null,
  }
}

run()
