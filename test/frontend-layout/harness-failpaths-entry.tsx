// REGRESSION harness for issue #375 (LOCAL/dev-machine only — spawns a real Electron GUI process).
// A user-initiated action that rejects must end in a state that says so: the control is usable
// again, nothing reports a success that did not happen, the reason is announced through the toast
// region, and no rejection escapes. The agent-desktop suite cannot make the clipboard reject and
// cannot read aria-disabled or focus, so the real DOM is the layer that can.
import './harness-bootstrap.js'
import '../../src/renderer/platform/i18n.js'
import type { ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ToastProvider } from './../../src/renderer/components/toast/ToastProvider.js'
import { KeyboardProvider } from './../../src/renderer/keyboard/KeyboardProvider.js'
import { ConnectionStatusProvider } from './../../src/renderer/hooks/useConnectionStatus.js'
import Account from '../../src/renderer/screens/AccountScreen.js'
import ActivityLogSettings from '../../src/renderer/screens/settings/ActivityLogSettings.js'
import NetworkDiagnosticsScreen from '../../src/renderer/screens/NetworkDiagnosticsScreen.js'
import CopyButton from './../../src/renderer/components/primitives/CopyButton.js'
import InviteModal from './../../src/renderer/components/modals/InviteModal.js'
import type { Profile } from '../../src/renderer/types/types.js'

interface ErrorFrame {
  id: number
  error: string
  code: string
}

interface SaveProbe { label: string; disabled: boolean; keptFocus: boolean; alert: boolean }
interface PurgeProbe { dialogOpen: boolean; confirmEnabled: boolean; claimsDone: boolean; alert: boolean }
interface VerboseProbe { checked: string | null; claimsOn: boolean; mainTurnedOn: number; alert: boolean }
interface CopyProbe { copiedBeforeResolve: boolean; labelAfterReject: string; alert: boolean; copiedAfterResolve: boolean }

interface HarnessResults {
  pass: boolean
  error: string | null
  save: SaveProbe | null
  purge: PurgeProbe | null
  verbose: VerboseProbe | null
  copy: CopyProbe | null
  invite: CopyProbe | null
  unhandled: number
}

declare global {
  interface Window {
    __results: HarnessResults
    __fakeEmit: (frame: ErrorFrame) => void
  }
}

// errorTextFor maps WORKER_UNAVAILABLE to its own sentence, so the toast is recognisably THIS
// failure rather than the generic fallback.
const UNAVAILABLE = { error: 'worker is still starting', code: 'WORKER_UNAVAILABLE' }
const UNAVAILABLE_TEXT = "isn't available"
const COPY_FAILED_TEXT = "Couldn't copy to the clipboard"
const VERBOSE_ON_TEXT = 'Detailed logging is on'

// Worker requests named here are answered with a coded error frame instead of reaching the fake
// worker; every other request passes through unchanged.
const FAILING = new Set(['audit:purge', 'setVerbose'])
const realWrite = window.bridge.writeWorkerIPC.bind(window.bridge)
window.bridge.writeWorkerIPC = (spec: string, data: Uint8Array | string) => {
  const text = typeof data === 'string' ? data : new TextDecoder().decode(data)
  const passthrough: string[] = []
  for (const line of text.split('\n')) {
    if (!line) continue
    const env = JSON.parse(line) as { id: number; type: string }
    if (FAILING.has(env.type)) Promise.resolve().then(() => window.__fakeEmit({ id: env.id, ...UNAVAILABLE }))
    else passthrough.push(line)
  }
  if (!passthrough.length) return Promise.resolve(true)
  return realWrite(spec, new TextEncoder().encode(passthrough.join('\n') + '\n'))
}

// The screen's unmount cleanup writes `false` to main, which is harmless; what must never happen
// is main switched ON while the worker refused.
let mainTurnedOn = 0
window.bridge.getIdentityProtection = () => Promise.resolve('protected')
window.bridge.setVerbose = (on?: boolean) => {
  if (on) mainTurnedOn += 1
  return Promise.resolve(false)
}

// The clipboard answers only when the harness says so, so "Copied" can be probed while the write
// is still in flight.
let pendingWrite: { resolve: () => void; reject: (e: DOMException) => void } | null = null
Object.defineProperty(navigator, 'clipboard', {
  configurable: true,
  value: {
    writeText: () =>
      new Promise<void>((resolve, reject) => {
        pendingWrite = { resolve, reject }
      }),
  },
})
const notFocused = () => new DOMException('Document is not focused.', 'NotAllowedError')

let unhandledRejections = 0
window.addEventListener('unhandledrejection', () => {
  unhandledRejections += 1
})

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const noop = () => {}
const PROFILE = { displayName: 'You', avatar: null } as Profile
const rejectsUnavailable = () => Promise.reject(Object.assign(new Error(UNAVAILABLE.error), { code: UNAVAILABLE.code }))

// A fresh provider per step: identical sentences from two steps would otherwise collapse into one
// toast, and a step would pass on the previous step's alert.
function Shell({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <ConnectionStatusProvider>
        <KeyboardProvider currentScreen="account" selectedSpaceId={null}>
          {children}
        </KeyboardProvider>
      </ConnectionStatusProvider>
    </ToastProvider>
  )
}

const alertSays = (text: string) =>
  Array.from(document.querySelectorAll('[role="alert"]')).some((n) => n.textContent?.includes(text))

function buttonWithText(text: string, scope: ParentNode = document): HTMLButtonElement | null {
  return Array.from(scope.querySelectorAll('button')).find((b) => b.textContent?.includes(text)) ?? null
}

// A controlled React input ignores a plain `.value =`; the native setter makes onChange fire.
function typeInto(el: HTMLInputElement, text: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(el, text)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

async function probeSave(root: Root): Promise<SaveProbe> {
  root.render(
    <Shell key="save">
      <Account profile={PROFILE} onSave={rejectsUnavailable} onBack={noop} onOpenNetworkStatus={noop} onOpenActivityLog={noop} onFeedback={noop} />
    </Shell>,
  )
  await sleep(300)
  typeInto(document.getElementById('account-display-name') as HTMLInputElement, 'You Renamed')
  await sleep(50)
  const before = buttonWithText('Save Changes')
  before?.focus()
  before?.click()
  await sleep(300)
  const after = buttonWithText('Save Changes') ?? buttonWithText('Saving')
  return {
    label: after?.textContent ?? '',
    disabled: !!after && (after.disabled || after.getAttribute('aria-disabled') === 'true'),
    keptFocus: !!after && document.activeElement === after,
    alert: alertSays(UNAVAILABLE_TEXT),
  }
}

async function probePurge(root: Root): Promise<PurgeProbe> {
  root.render(<Shell key="purge"><ActivityLogSettings onBack={noop} onOpenLog={noop} /></Shell>)
  await sleep(300)
  buttonWithText('Delete')?.click()
  await sleep(200)
  const dialog = document.querySelector('[role="alertdialog"]')
  if (dialog) buttonWithText('Delete', dialog)?.click()
  await sleep(300)
  const open = document.querySelector('[role="alertdialog"]')
  const confirm = open ? buttonWithText('Delete', open) : null
  return {
    dialogOpen: !!open,
    confirmEnabled: !!confirm && !confirm.disabled,
    claimsDone: document.body.textContent?.includes('Deleted') ?? false,
    alert: alertSays(UNAVAILABLE_TEXT),
  }
}

async function probeVerbose(root: Root): Promise<VerboseProbe> {
  root.render(<Shell key="verbose"><NetworkDiagnosticsScreen onBack={noop} /></Shell>)
  await sleep(300)
  const logs = () =>
    Array.from(document.querySelectorAll<HTMLElement>('[role="switch"]')).find((s) =>
      (s.closest('label')?.textContent ?? s.textContent ?? '').includes('detailed logs'),
    )
  logs()?.click()
  await sleep(300)
  return {
    checked: logs()?.getAttribute('aria-checked') ?? null,
    claimsOn: document.body.textContent?.includes(VERBOSE_ON_TEXT) ?? false,
    mainTurnedOn,
    alert: alertSays(UNAVAILABLE_TEXT),
  }
}

// One control, three moments: in flight (must not say Copied), rejected (must say why and still
// offer Copy), then a second attempt that resolves (must say Copied).
async function probeCopy(find: () => HTMLButtonElement | null, labelOf: (b: HTMLButtonElement) => string): Promise<CopyProbe> {
  find()?.click()
  await sleep(100)
  const inFlight = find()
  const copiedBeforeResolve = !!inFlight && labelOf(inFlight).includes('Copied')
  pendingWrite?.reject(notFocused())
  await sleep(200)
  const rejected = find()
  const labelAfterReject = rejected ? labelOf(rejected) : ''
  const alert = alertSays(COPY_FAILED_TEXT)
  find()?.click()
  await sleep(50)
  pendingWrite?.resolve()
  await sleep(150)
  const resolved = find()
  return { copiedBeforeResolve, labelAfterReject, alert, copiedAfterResolve: !!resolved && labelOf(resolved).includes('Copied') }
}

const copyOk = (c: CopyProbe) =>
  !c.copiedBeforeResolve && c.labelAfterReject.includes('Copy') && !c.labelAfterReject.includes('Copied') && c.alert && c.copiedAfterResolve

async function run(root: Root): Promise<HarnessResults> {
  const save = await probeSave(root)
  const purge = await probePurge(root)
  const verbose = await probeVerbose(root)

  root.render(<Shell key="copy"><div className="p-8"><CopyButton value="Mirall v0.0.0-test" /></div></Shell>)
  await sleep(200)
  const copy = await probeCopy(
    () => document.querySelector<HTMLButtonElement>('button[aria-label="Copy"], button[aria-label="Copied!"]'),
    (b) => b.getAttribute('aria-label') ?? '',
  )

  root.render(<Shell key="invite"><InviteModal isOpen onClose={noop} onCreate={() => Promise.resolve('code123')} /></Shell>)
  await sleep(300)
  buttonWithText('Create')?.click()
  await sleep(300)
  const invite = await probeCopy(
    () => buttonWithText('Copied') ?? buttonWithText('Copy'),
    (b) => b.textContent ?? '',
  )

  const pass =
    save.label.includes('Save Changes') && !save.disabled && save.keptFocus && save.alert &&
    purge.dialogOpen && purge.confirmEnabled && !purge.claimsDone && purge.alert &&
    verbose.checked === 'false' && !verbose.claimsOn && verbose.mainTurnedOn === 0 && verbose.alert &&
    copyOk(copy) && copyOk(invite) &&
    unhandledRejections === 0
  return { pass, error: null, save, purge, verbose, copy, invite, unhandled: unhandledRejections }
}

const root = createRoot(document.getElementById('root') as HTMLElement)
run(root).then(
  (results) => {
    window.__results = results
  },
  (e: Error) => {
    window.__results = { pass: false, error: String(e), save: null, purge: null, verbose: null, copy: null, invite: null, unhandled: unhandledRejections }
  },
)
