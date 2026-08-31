// Real-Chromium harness for the join-request in-flight affordance (LOCAL/dev-machine only —
// spawns a real Electron GUI process). Mounts the REAL <SpaceView> with one pending request,
// clicks Approve, and asserts the button disables while the (deliberately delayed) approve RPC
// is in flight, that the derived request row is NEVER hidden (Fix B keeps the projection as the
// sole source of truth — no reconcile hint is emitted here), and that the button re-enables once
// the call settles. window.bridge is installed by fake-bridge.js loaded first in the HTML.
import './harness-bootstrap.js'
import { createRoot } from 'react-dom/client'
import i18n from './../../src/renderer/i18n.js'
import { ToastProvider } from './../../src/renderer/components/toast/ToastProvider.js'
import { KeyboardProvider } from './../../src/renderer/keyboard/KeyboardProvider.js'
import SpaceView from './../../src/renderer/screens/SpaceView.js'

interface FakeDriver {
  SPACE_ID: string
}

interface HarnessResults {
  initiallyEnabled: boolean
  disabledWhileBusy: boolean
  rowPersists: boolean
  reenabledAfter: boolean
  pass: boolean
  error: string | null
}

declare global {
  interface Window {
    __fake: FakeDriver
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function approveButton(): HTMLButtonElement | null {
  const label = i18n.t('member.approveNamed', { name: 'Bob' })
  return document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
}

function publishError(error: string): void {
  window.__results = { initiallyEnabled: false, disabledWhileBusy: false, rowPersists: false, reenabledAfter: false, pass: false, error }
}

async function run() {
  const deadline = Date.now() + 8000
  let btn = approveButton()
  while (!btn && Date.now() < deadline) {
    await sleep(50)
    btn = approveButton()
  }
  if (!btn) return publishError('Approve control never rendered')

  const initiallyEnabled = !btn.disabled
  btn.click()

  let disabledWhileBusy = false
  const busyDeadline = Date.now() + 350
  while (Date.now() < busyDeadline) {
    const b = approveButton()
    if (b && b.disabled) { disabledWhileBusy = true; break }
    await sleep(10)
  }

  await sleep(700)
  const after = approveButton()
  const rowPersists = after !== null
  const reenabledAfter = after !== null && !after.disabled

  window.__results = {
    initiallyEnabled,
    disabledWhileBusy,
    rowPersists,
    reenabledAfter,
    pass: initiallyEnabled && disabledWhileBusy && rowPersists && reenabledAfter,
    error: null,
  }
}

run()
