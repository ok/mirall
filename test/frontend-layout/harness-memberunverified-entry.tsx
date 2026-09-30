// Real-Chromium harness for the unverified member pill. Mounts the REAL <SpaceScreen> inside the
// REAL app-shell wrappers, expands the Members box, and asserts that a roster entry flagged
// unverified wears the pill as ONE text node in place of the online icon, that self never does,
// and that clearing the flag drops the pill from the same row — re-rendered in place, not remounted.
import './harness-bootstrap.js'
import { createRoot } from 'react-dom/client'
import i18n from '../../src/renderer/platform/i18n.js'
import { ToastProvider } from '../../src/renderer/components/toast/ToastProvider.js'
import { KeyboardProvider } from '../../src/renderer/keyboard/KeyboardProvider.js'
import SpaceScreen from '../../src/renderer/screens/SpaceScreen.js'

interface FakeMember {
  publicKey: string
  displayName: string
  online: boolean
  avatar: string | null
  unverified?: boolean
}

interface FakeDriver {
  SPACE_ID: string
  members: FakeMember[]
}

interface ReconcileEvent {
  type: 'event:reconcile'
  scope: { kind: string; spaceId: string }
}

interface HarnessResults {
  pillShown: boolean
  oneNode: boolean
  iconWithheld: boolean
  selfClean: boolean
  clearedInPlace: boolean
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
f.members[0].unverified = true

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

function nodesCarrying(row: HTMLElement, text: string): number {
  return Array.from(row.querySelectorAll('*')).filter((el) => el.textContent === text).length
}

const hasIcon = (row: HTMLElement) => row.querySelector(':scope > svg') !== null

function publishError(error: string): void {
  window.__results = {
    pillShown: false, oneNode: false, iconWithheld: false, selfClean: false, clearedInPlace: false, pass: false, error,
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

  const flaggedRow = rowFor(card, 'Vhinz')
  const selfRow = rowFor(card, 'You')
  if (!flaggedRow || !selfRow) return publishError('the two member rows did not render')

  const pill = i18n.t('member.unverified')
  const pillShown = (flaggedRow.textContent ?? '').includes(pill)
  const oneNode = nodesCarrying(flaggedRow, pill) === 1
  const iconWithheld = !hasIcon(flaggedRow) && hasIcon(selfRow)
  const selfClean = nodesCarrying(selfRow, pill) === 0

  const avatarBefore = flaggedRow.querySelector('div.relative')
  f.members[0].unverified = false
  window.__fakeEmit({ type: 'event:reconcile', scope: { kind: 'members', spaceId: f.SPACE_ID } })
  const clearDeadline = Date.now() + 4000
  let afterRow = rowFor(card, 'Vhinz')
  while (afterRow && nodesCarrying(afterRow, pill) > 0 && Date.now() < clearDeadline) {
    await sleep(50)
    afterRow = rowFor(card, 'Vhinz')
  }
  const clearedInPlace = !!afterRow &&
    nodesCarrying(afterRow, pill) === 0 &&
    hasIcon(afterRow) &&
    afterRow.querySelector('div.relative') === avatarBefore

  window.__results = {
    pillShown,
    oneNode,
    iconWithheld,
    selfClean,
    clearedInPlace,
    pass: pillShown && oneNode && iconWithheld && selfClean && clearedInPlace,
    error: null,
  }
}

run()
