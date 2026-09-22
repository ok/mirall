// Real-Chromium harness for a deny that lands on a peer a co-member already approved. Mounts the
// REAL <SpaceScreen> with one pending request, clicks Deny, and asserts the control disables while
// the delayed deny is in flight, then that the worker's already-approved outcome is spoken as a
// polite status toast that stays until dismissed. A second Deny finds nothing open and says so,
// politely too. window.bridge is installed by fake-bridge.js.
import './harness-bootstrap.js'
import { createRoot } from 'react-dom/client'
import i18n from '../../src/renderer/platform/i18n.js'
import { ToastProvider } from './../../src/renderer/components/toast/ToastProvider.js'
import { KeyboardProvider } from './../../src/renderer/keyboard/KeyboardProvider.js'
import SpaceScreen from '../../src/renderer/screens/SpaceScreen.js'

interface FakeDriver {
  SPACE_ID: string
}

interface HarnessResults {
  initiallyEnabled: boolean
  disabledWhileBusy: boolean
  politeStatus: boolean
  notAlert: boolean
  sticky: boolean
  notOpenPolite: boolean
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
          <SpaceScreen spaceId={f.SPACE_ID} onBack={() => {}} onManageStorage={() => {}} />
        </KeyboardProvider>
      </ToastProvider>
    </main>
  </div>,
)

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const message = i18n.t('member.denyAlreadyApproved', { name: 'Bob' })
const notOpen = i18n.t('member.denyNotOpen')

function denyButton(): HTMLButtonElement | null {
  const label = i18n.t('member.denyNamed', { name: 'Bob' })
  return document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
}

function toastWith(role: string, text = message): HTMLElement | null {
  return [...document.querySelectorAll<HTMLElement>(`[role="${role}"]`)].find((el) => el.textContent?.includes(text)) ?? null
}

async function waitForToast(text: string): Promise<HTMLElement | null> {
  const deadline = Date.now() + 3000
  let status = toastWith('status', text)
  while (!status && Date.now() < deadline) {
    await sleep(50)
    status = toastWith('status', text)
  }
  return status
}

function publishError(error: string): void {
  window.__results = { initiallyEnabled: false, disabledWhileBusy: false, politeStatus: false, notAlert: false, sticky: false, notOpenPolite: false, pass: false, error }
}

async function run() {
  const deadline = Date.now() + 8000
  let btn = denyButton()
  while (!btn && Date.now() < deadline) {
    await sleep(50)
    btn = denyButton()
  }
  if (!btn) return publishError('Deny control never rendered')

  const initiallyEnabled = !btn.disabled
  btn.click()

  let disabledWhileBusy = false
  const busyDeadline = Date.now() + 350
  while (Date.now() < busyDeadline) {
    if (denyButton()?.disabled) { disabledWhileBusy = true; break }
    await sleep(10)
  }

  const status = await waitForToast(message)
  const politeStatus = status?.getAttribute('aria-live') === 'polite'
  const notAlert = toastWith('alert') === null

  // Past the 5 s default an auto-dismissing toast would already be gone.
  await sleep(6000)
  const sticky = politeStatus && toastWith('status') !== null

  denyButton()?.click()
  const notOpenPolite = (await waitForToast(notOpen))?.getAttribute('aria-live') === 'polite' && toastWith('alert', notOpen) === null

  window.__results = {
    initiallyEnabled,
    disabledWhileBusy,
    politeStatus,
    notAlert,
    sticky,
    notOpenPolite,
    pass: initiallyEnabled && disabledWhileBusy && politeStatus && notAlert && sticky && notOpenPolite,
    error: null,
  }
}

run()
