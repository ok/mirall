// The #446 half of the failpaths harness: the actions that dropped their failure after #375. Each
// probe fails one action under the real screen or hook and asserts that the failure is said —
// inline where no toast region exists, as a toast where one does — and that nothing escapes.
import type { ComponentType, ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import Account from '../../src/renderer/screens/AccountScreen.js'
import OnboardingScreen from '../../src/renderer/screens/OnboardingScreen.js'
import ActivityLogSettings from '../../src/renderer/screens/settings/ActivityLogSettings.js'
import NetworkSettings from '../../src/renderer/screens/settings/NetworkSettings.js'
import RelaySettingsSection from '../../src/renderer/screens/settings/RelaySettingsSection.js'
import NetworkStatusScreen from '../../src/renderer/screens/NetworkStatusScreen.js'
import { useTransferControls } from '../../src/renderer/hooks/useTransferControls.js'
import { useShareFiles } from '../../src/renderer/hooks/useShareFiles.js'
import { useFiles } from '../../src/renderer/hooks/useFiles.js'
import { isApplyArmed, setApplyArmed, setReconnectPending } from '../../src/renderer/platform/relay-session.js'
import { setRelay, type RelaySlot } from '../../src/renderer/platform/config-client.js'
import { resetMainStore } from '../../src/renderer/store/main-store.js'
import type { FileEntry, Profile } from '../../src/renderer/types/types.js'

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }
export type WorkerAnswer = 'fail' | 'failUncoded' | 'hold' | { data: Json }

export interface FailpathsKit {
  Shell: ComponentType<{ children: ReactNode }>
  answer: (type: string, how: WorkerAnswer | null) => void
  releaseHeld: () => void
  asked: (type: string) => number
  sleep: (ms: number) => Promise<void>
  alertSays: (text: string) => boolean
  buttonWithText: (text: string, scope?: ParentNode) => HTMLButtonElement | null
  typeInto: (el: HTMLInputElement, text: string) => void
  rejectsUnavailable: () => Promise<never>
  profile: Profile
  unavailableText: string
  unhandled: () => number
  logged: () => number
}

interface AvatarProbe { account: boolean; onboarding: boolean; staleSuccessIgnored: boolean; staleFailureIgnored: boolean; successClearsError: boolean; escaped: number }
interface OnboardingProbe {
  alert: boolean; describedBy: boolean; keptFocus: boolean; usable: boolean
  busyWhileSaving: boolean; callsWhileSaving: number; escaped: number
}
interface AuditProbe { toggleChecked: string | null; toggleAlert: boolean; retentionKept: boolean; retentionAlert: boolean; busyWhilePatching: boolean; sentWhilePatching: number; usableAfter: boolean; escaped: number }
interface BusyControl { focusable: boolean; busy: boolean; keptFocus: boolean }
interface RelayProbe {
  applyAlert: boolean; applyStillArmed: boolean; throttleAlert: boolean; throttleStillArmed: boolean; applyBusy: BusyControl
  restartAlert: boolean; modeAlert: boolean; alwaysAlert: boolean; removeAlert: boolean; escaped: number
}
interface ReconnectProbe { alert: boolean; stillArmed: boolean; throttleAlert: boolean; throttleStillArmed: boolean; busy: BusyControl; escaped: number }
interface WhatsNewProbe { failAlert: boolean; emptyStatus: boolean; escaped: number }
interface BandwidthProbe {
  statusRegionBeforeFailure: boolean; statusRegionHoldsNote: boolean
  workerRejectNoteIsStatus: boolean; workerRejectNoteIsAlert: boolean; workerRejectSaysSaveFailed: boolean
  persistRejectSaysSaveFailed: boolean; persistRejectAskedWorker: number
  presetsBusyWhileApplying: boolean; appliesWhileApplying: number; escaped: number
}

export interface DroppedResults {
  avatar: AvatarProbe
  onboarding: OnboardingProbe
  audit: AuditProbe
  transfers: { reported: Record<string, boolean>; logged: Record<string, boolean>; transferFallback: Record<string, boolean>; escaped: number }
  relay: RelayProbe
  reconnect: ReconnectProbe
  whatsNew: WhatsNewProbe
  bandwidth: BandwidthProbe
}

const AVATAR_UNREADABLE_TEXT = "Couldn't read that image"
const GENERIC_TEXT = 'Something went wrong'
const WHATS_NEW_EMPTY_TEXT = 'No release notes'
const RESTART_TEXT = 'takes effect after Mirall restarts'
const SAVE_FAILED_TEXT = "Couldn't save that limit"
const RECONNECT_NOW = 'Reconnect now'
const RECONNECTING = 'Reconnecting'
const THROTTLED_TEXT = 'Mirall reconnected moments ago'
const TRANSFER_FAILED_TEXT = 'Transfer failed'
const THROTTLED: Json = { ok: false, throttled: true }

const noop = () => {}

const statusSays = (text: string) =>
  Array.from(document.querySelectorAll('[role="status"]')).some((n) => n.textContent?.includes(text))

// Enough of a network status frame for the screens to render a verdict that offers Reconnect, and a
// relayed connection the relay notice counts as stale.
export const OFFLINE_STATUS: { [key: string]: Json } = {
  state: 'offline', dhtReady: true, announced: false, peerCount: 0, connecting: 0, suspended: false,
  lastConnectionAt: null, bootedAt: 0,
  identity: { publicKey: 'p'.repeat(64), nodeId: null },
  address: { publicHost: null, publicPort: 0, localPort: 0 },
  nat: { firewalled: null, randomized: null, ephemeral: false },
  routing: { bootstrap: [], tableSize: 0 },
  topics: 0,
  peerReach: { discovered: 0, connected: 0 },
  canary: { state: 'unavailable', at: null },
  relay: { connections: [{ via: 'own', supplied: true, relayMode: 'auto', replaced: false }], direct: { control: 0, content: 0 } },
  reachability: { verdict: 'offline', cause: 'generic' },
  versions: { dht: '0' },
}

// A file whose name starts with "slow" is read late, so two picks can settle out of order.
const RealFileReader = window.FileReader
class OrderedFileReader extends RealFileReader {
  readAsDataURL(blob: Blob): void {
    if (blob instanceof File && blob.name.startsWith('slow')) setTimeout(() => super.readAsDataURL(blob), 400)
    else super.readAsDataURL(blob)
  }
}

const BROKEN_BYTES = new Uint8Array([1, 2, 3, 4])

async function goodImageBytes(): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = 8
  canvas.height = 8
  canvas.getContext('2d')?.fillRect(0, 0, 8, 8)
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b ?? new Blob()), 'image/png'))
}

function pick(name: string, bytes: BlobPart): void {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')
  if (!input) return
  const dt = new DataTransfer()
  dt.items.add(new File([bytes], name, { type: 'image/png' }))
  input.files = dt.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

const avatarShown = () => !!document.querySelector('button[aria-label="Change profile picture"] img')

async function probeAvatar(root: Root, kit: FailpathsKit): Promise<AvatarProbe> {
  const { Shell } = kit
  const before = kit.unhandled()
  root.render(
    <Shell key="avatar-account">
      <Account profile={kit.profile} onSave={() => Promise.resolve()} onBack={noop} onOpenNetworkStatus={noop} onOpenActivityLog={noop} onFeedback={noop} />
    </Shell>,
  )
  await kit.sleep(300)
  pick('broken.png', BROKEN_BYTES)
  await kit.sleep(400)
  const account = kit.alertSays(AVATAR_UNREADABLE_TEXT)

  root.render(<OnboardingScreen key="avatar-onboarding" onComplete={() => Promise.resolve()} />)
  await kit.sleep(300)
  pick('broken.png', BROKEN_BYTES)
  await kit.sleep(400)
  const onboarding = kit.alertSays(AVATAR_UNREADABLE_TEXT)

  const good = await goodImageBytes()
  window.FileReader = OrderedFileReader
  root.render(<OnboardingScreen key="avatar-stale-success" onComplete={() => Promise.resolve()} />)
  await kit.sleep(300)
  pick('slow-good.png', good)
  pick('broken.png', BROKEN_BYTES)
  await kit.sleep(800)
  const staleSuccessIgnored = kit.alertSays(AVATAR_UNREADABLE_TEXT) && !avatarShown()

  root.render(<OnboardingScreen key="avatar-stale-failure" onComplete={() => Promise.resolve()} />)
  await kit.sleep(300)
  pick('slow-broken.png', BROKEN_BYTES)
  pick('good.png', good)
  await kit.sleep(800)
  const staleFailureIgnored = !kit.alertSays(AVATAR_UNREADABLE_TEXT) && avatarShown()
  window.FileReader = RealFileReader

  root.render(<OnboardingScreen key="avatar-recover" onComplete={() => Promise.resolve()} />)
  await kit.sleep(300)
  pick('broken.png', BROKEN_BYTES)
  await kit.sleep(400)
  pick('good.png', good)
  await kit.sleep(400)
  const successClearsError = !kit.alertSays(AVATAR_UNREADABLE_TEXT) && avatarShown()
  return { account, onboarding, staleSuccessIgnored, staleFailureIgnored, successClearsError, escaped: kit.unhandled() - before }
}

const continueButton = (kit: FailpathsKit) => kit.buttonWithText('Continue') ?? kit.buttonWithText('Saving')

// Onboarding renders before the toast region exists, so its failure has to be said in place.
async function probeOnboarding(root: Root, kit: FailpathsKit): Promise<OnboardingProbe> {
  const before = kit.unhandled()
  root.render(<OnboardingScreen key="onboarding-reject" onComplete={kit.rejectsUnavailable} />)
  await kit.sleep(300)
  kit.typeInto(document.getElementById('display-name') as HTMLInputElement, 'New User')
  await kit.sleep(50)
  continueButton(kit)?.focus()
  continueButton(kit)?.click()
  await kit.sleep(300)
  const after = continueButton(kit)
  const alertId = document.querySelector('[role="alert"]')?.id ?? ''
  const rejected = {
    alert: kit.alertSays(kit.unavailableText),
    describedBy: !!after && !!alertId && (after.getAttribute('aria-describedby') ?? '').split(' ').includes(alertId),
    keptFocus: !!after && document.activeElement === after,
    usable: !!after && !after.disabled && after.getAttribute('aria-disabled') !== 'true',
  }

  let calls = 0
  const pending: { settle?: () => void } = {}
  const heldSave = () => {
    calls += 1
    return new Promise<never>((_resolve, reject) => {
      pending.settle = () => reject(Object.assign(new Error('worker is still starting'), { code: 'WORKER_UNAVAILABLE' }))
    })
  }
  root.render(<OnboardingScreen key="onboarding-held" onComplete={heldSave} />)
  await kit.sleep(300)
  const field = document.getElementById('display-name') as HTMLInputElement
  kit.typeInto(field, 'New User')
  await kit.sleep(50)
  continueButton(kit)?.click()
  await kit.sleep(50)
  const busyWhileSaving = continueButton(kit)?.getAttribute('aria-disabled') === 'true'
  continueButton(kit)?.click()
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await kit.sleep(50)
  const callsWhileSaving = calls
  pending.settle?.()
  await kit.sleep(200)
  return { ...rejected, busyWhileSaving, callsWhileSaving, escaped: kit.unhandled() - before }
}

const recordSwitch = () => document.querySelector<HTMLElement>('[role="switch"][aria-label="Record activity"]')

async function probeAudit(root: Root, kit: FailpathsKit): Promise<AuditProbe> {
  const { Shell } = kit
  const before = kit.unhandled()
  kit.answer('audit:get-config', { data: { enabled: true, retentionDays: 90, maxEntries: 10000 } })
  kit.answer('audit:configure', 'fail')

  root.render(<Shell key="audit-toggle"><ActivityLogSettings onBack={noop} onOpenLog={noop} /></Shell>)
  await kit.sleep(300)
  recordSwitch()?.click()
  await kit.sleep(300)
  const toggleChecked = recordSwitch()?.getAttribute('aria-checked') ?? null
  const toggleAlert = kit.alertSays(kit.unavailableText)

  root.render(<Shell key="audit-retention"><ActivityLogSettings onBack={noop} onOpenLog={noop} /></Shell>)
  await kit.sleep(300)
  kit.buttonWithText('30 days')?.click()
  await kit.sleep(300)
  const retentionKept = kit.buttonWithText('90 days')?.getAttribute('aria-pressed') === 'true'
  const retentionAlert = kit.alertSays(kit.unavailableText)

  root.render(<Shell key="audit-held"><ActivityLogSettings onBack={noop} onOpenLog={noop} /></Shell>)
  await kit.sleep(300)
  kit.answer('audit:configure', 'hold')
  const sentBefore = kit.asked('audit:configure')
  recordSwitch()?.click()
  await kit.sleep(50)
  const busyWhilePatching = recordSwitch()?.getAttribute('aria-disabled') === 'true'
  recordSwitch()?.click()
  kit.buttonWithText('30 days')?.click()
  await kit.sleep(50)
  const sentWhilePatching = kit.asked('audit:configure') - sentBefore
  kit.releaseHeld()
  await kit.sleep(300)
  const usableAfter = recordSwitch()?.getAttribute('aria-disabled') !== 'true'

  kit.answer('audit:configure', null)
  kit.answer('audit:get-config', null)
  return { toggleChecked, toggleAlert, retentionKept, retentionAlert, busyWhilePatching, sentWhilePatching, usableAfter, escaped: kit.unhandled() - before }
}

const LOOSE_FILE: FileEntry = {
  path: '/a.bin', size: 1, hash: 'h'.repeat(64), owner: { displayName: 'Vhinz', publicKey: 'owner' },
  localBytes: 0, isAvailable: true, status: 'remote',
}

const TRANSFER_FAILS = [
  'files:cancel-download', 'files:pause-download', 'share:read-file', 'share:reveal-file', 'files:download',
]

// The row controls are handed to memoized rows as `(x) => void`: one button per control, wired the
// way FolderScreen and SpaceScreen wire them, straight from the hooks.
function TransferControls({ only }: { only: string }) {
  const { cancelDownload, pauseDownload } = useTransferControls()
  const share = useShareFiles('space1', 'owner-pk', 'share1')
  const loose = useFiles('space1')
  const acts: Record<string, () => void> = {
    'cancel': () => { cancelDownload('t1') },
    'pause': () => { pauseDownload('t1') },
    'folder-download': () => { share.downloadFile('a.bin') },
    'folder-reveal': () => { share.revealFile('a.bin') },
    'space-download': () => { loose.downloadFile(LOOSE_FILE) },
  }
  return <button type="button" onClick={acts[only]}>{`act ${only}`}</button>
}

const TRANSFER_ACTS = ['cancel', 'pause', 'folder-download', 'folder-reveal', 'space-download']

async function probeTransfers(root: Root, kit: FailpathsKit): Promise<DroppedResults['transfers']> {
  const { Shell } = kit
  const before = kit.unhandled()
  for (const type of TRANSFER_FAILS) kit.answer(type, 'fail')
  const reported: Record<string, boolean> = {}
  const logged: Record<string, boolean> = {}
  for (const act of TRANSFER_ACTS) {
    root.render(<Shell key={`transfer-${act}`}><TransferControls only={act} /></Shell>)
    await kit.sleep(200)
    const loggedBefore = kit.logged()
    kit.buttonWithText(`act ${act}`)?.click()
    await kit.sleep(300)
    reported[act] = kit.alertSays(kit.unavailableText)
    logged[act] = kit.logged() > loggedBefore
  }
  // A failure with no code of its own reads as the transfer sentence, as a failed upload does.
  for (const type of TRANSFER_FAILS) kit.answer(type, 'failUncoded')
  const transferFallback: Record<string, boolean> = {}
  for (const act of ['space-download', 'cancel']) {
    root.render(<Shell key={`transfer-uncoded-${act}`}><TransferControls only={act} /></Shell>)
    await kit.sleep(200)
    kit.buttonWithText(`act ${act}`)?.click()
    await kit.sleep(300)
    transferFallback[act] = kit.alertSays(TRANSFER_FAILED_TEXT)
  }
  for (const type of TRANSFER_FAILS) kit.answer(type, null)
  return { reported, logged, transferFallback, escaped: kit.unhandled() - before }
}

// A control that is busy while its request is in flight must stay focusable and keep focus, so a
// refusal announced a moment later is heard from where the user is.
async function busyWhileHeld(kit: FailpathsKit, find: () => HTMLButtonElement | null): Promise<BusyControl> {
  kit.answer('network:reconnect', 'hold')
  find()?.focus()
  find()?.click()
  await kit.sleep(100)
  const b = find()
  const result = {
    focusable: !!b && !b.disabled,
    busy: b?.getAttribute('aria-disabled') === 'true',
    keptFocus: !!b && document.activeElement === b,
  }
  kit.releaseHeld()
  await kit.sleep(300)
  return result
}

const SLOT: RelaySlot = { publicKey: 'r'.repeat(64), kind: 'open', label: 'Test relay', enabled: true, lastTest: { at: 1, ok: true } }

// Seeds the section's boot snapshot through the same setter the screen uses.
async function seedRelay(relay: RelaySlot | null): Promise<void> {
  const relayMode = relay ? 'auto' : 'off'
  window.bridge.setRelay = () => Promise.resolve({ ok: true, network: { downloadKBps: 0, uploadKBps: 0, relayMode, relay }, identityChanged: false })
  await setRelay({ mode: relayMode })
}

const switchLabelled = (text: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('[role="switch"]')).find((sw) =>
    document.getElementById(sw.getAttribute('aria-labelledby') ?? '')?.textContent?.includes(text),
  ) ?? null

async function relayCommitFails(root: Root, kit: FailpathsKit, key: string, act: () => Promise<void>): Promise<boolean> {
  const { Shell } = kit
  root.render(<Shell key={key}><RelaySettingsSection /></Shell>)
  await kit.sleep(300)
  window.bridge.setRelay = () => Promise.reject(new Error('the relay vault is locked'))
  await act()
  await kit.sleep(300)
  const said = kit.alertSays(GENERIC_TEXT)
  await seedRelay(SLOT)
  return said
}

async function probeRelay(root: Root, kit: FailpathsKit): Promise<RelayProbe> {
  const { Shell } = kit
  const before = kit.unhandled()
  const realSetRelay = window.bridge.setRelay
  kit.answer('network:status:get', { data: OFFLINE_STATUS })
  kit.answer('network:reconnect', 'fail')
  setApplyArmed(true)
  root.render(<Shell key="relay-apply"><RelaySettingsSection /></Shell>)
  await kit.sleep(400)
  kit.buttonWithText(RECONNECT_NOW)?.click()
  await kit.sleep(300)
  const applyAlert = kit.alertSays(kit.unavailableText)
  const applyStillArmed = isApplyArmed()

  kit.answer('network:reconnect', { data: THROTTLED })
  root.render(<Shell key="relay-throttled"><RelaySettingsSection /></Shell>)
  await kit.sleep(300)
  kit.buttonWithText(RECONNECT_NOW)?.click()
  await kit.sleep(300)
  const throttleAlert = kit.alertSays(THROTTLED_TEXT)
  const throttleStillArmed = isApplyArmed()

  root.render(<Shell key="relay-busy"><RelaySettingsSection /></Shell>)
  await kit.sleep(300)
  const applyBusy = await busyWhileHeld(kit, () => kit.buttonWithText(RECONNECT_NOW) ?? kit.buttonWithText(RECONNECTING))
  setApplyArmed(false)

  const realRestart = window.bridge.restartWorker
  window.bridge.restartWorker = () => Promise.reject(new Error('main could not restart the worker'))
  setReconnectPending(true)
  root.render(<Shell key="relay-restart"><RelaySettingsSection /></Shell>)
  await kit.sleep(300)
  kit.buttonWithText(RECONNECT_NOW)?.click()
  await kit.sleep(300)
  const restartAlert = kit.alertSays(GENERIC_TEXT)
  setReconnectPending(false)
  window.bridge.restartWorker = realRestart
  kit.answer('network:reconnect', null)
  kit.answer('network:status:get', null)

  await seedRelay(SLOT)
  const modeAlert = await relayCommitFails(root, kit, 'relay-mode', async () => { switchLabelled('Use a relay')?.click() })
  const alwaysAlert = await relayCommitFails(root, kit, 'relay-always', async () => { switchLabelled('Prefer the relay')?.click() })
  const removeAlert = await relayCommitFails(root, kit, 'relay-remove', async () => {
    document.querySelector<HTMLButtonElement>('button[aria-label="Options for Test relay"]')?.click()
    await kit.sleep(200)
    Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((i) => i.textContent?.includes('Remove'))?.click()
  })
  await seedRelay(null)
  window.bridge.setRelay = realSetRelay
  return { applyAlert, applyStillArmed, throttleAlert, throttleStillArmed, applyBusy, restartAlert, modeAlert, alwaysAlert, removeAlert, escaped: kit.unhandled() - before }
}

const reconnectButton = () => document.querySelector<HTMLButtonElement>('button[aria-label="Reconnect"]')

function renderStatusScreen(root: Root, kit: FailpathsKit, key: string): void {
  const { Shell } = kit
  root.render(
    <Shell key={key}>
      <NetworkStatusScreen onBack={noop} onShowHistory={noop} onOpenSettings={noop} onOpenDiagnostics={noop} onOpenAdvanced={noop} />
    </Shell>,
  )
}

// The reconnect is what applies an armed relay change, so a refused or throttled one leaves it armed.
async function probeReconnect(root: Root, kit: FailpathsKit): Promise<ReconnectProbe> {
  const before = kit.unhandled()
  kit.answer('network:status:get', { data: OFFLINE_STATUS })
  kit.answer('network:reconnect', 'fail')
  setApplyArmed(true)
  renderStatusScreen(root, kit, 'network-status')
  await kit.sleep(400)
  reconnectButton()?.click()
  await kit.sleep(300)
  const alert = kit.alertSays(kit.unavailableText)
  const stillArmed = isApplyArmed()

  kit.answer('network:reconnect', { data: THROTTLED })
  renderStatusScreen(root, kit, 'network-status-throttled')
  await kit.sleep(400)
  reconnectButton()?.click()
  await kit.sleep(300)
  const throttleAlert = kit.alertSays(THROTTLED_TEXT)
  const throttleStillArmed = isApplyArmed()

  renderStatusScreen(root, kit, 'network-status-busy')
  await kit.sleep(400)
  const busy = await busyWhileHeld(kit, reconnectButton)

  setApplyArmed(false)
  kit.answer('network:reconnect', null)
  kit.answer('network:status:get', null)
  return { alert, stillArmed, throttleAlert, throttleStillArmed, busy, escaped: kit.unhandled() - before }
}

async function probeWhatsNew(root: Root, kit: FailpathsKit): Promise<WhatsNewProbe> {
  const { Shell } = kit
  const before = kit.unhandled()
  const account = (key: string) => (
    <Shell key={key}>
      <Account profile={kit.profile} onSave={() => Promise.resolve()} onBack={noop} onOpenNetworkStatus={noop} onOpenActivityLog={noop} onFeedback={noop} />
    </Shell>
  )
  const realChangelog = window.bridge.getChangelog
  window.bridge.getChangelog = () => Promise.reject(new Error('changelog unreadable'))
  root.render(account('whats-new-fail'))
  await kit.sleep(300)
  kit.buttonWithText("What's new")?.click()
  await kit.sleep(300)
  const failAlert = kit.alertSays(GENERIC_TEXT)

  window.bridge.getChangelog = () => Promise.resolve('')
  root.render(account('whats-new-empty'))
  await kit.sleep(300)
  kit.buttonWithText("What's new")?.click()
  await kit.sleep(300)
  const emptyStatus = statusSays(WHATS_NEW_EMPTY_TEXT)
  window.bridge.getChangelog = realChangelog
  return { failAlert, emptyStatus, escaped: kit.unhandled() - before }
}

const presetButton = (rate: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="Download limit: ${rate}"]`)
const noteIs = (role: 'status' | 'alert', text: string) =>
  Array.from(document.querySelectorAll(`[role="${role}"]`)).some((n) => n.textContent?.includes(text))

// Persist first, then the worker: the worker boots from the persisted value, so a worker refusal
// means "saved, applies after a restart" — a note, not an alarm — and a persist refusal means
// nothing changed anywhere.
async function probeBandwidth(root: Root, kit: FailpathsKit): Promise<BandwidthProbe> {
  const { Shell } = kit
  const before = kit.unhandled()
  const realGet = window.bridge.getBandwidth
  const realSet = window.bridge.setBandwidth
  window.bridge.getBandwidth = () => Promise.resolve({ downloadKBps: 0, uploadKBps: 0 })
  window.bridge.setBandwidth = (v) => Promise.resolve(v)
  kit.answer('settings:set-bandwidth', 'fail')
  root.render(<Shell key="bandwidth-worker"><NetworkSettings onBack={noop} onOpenStatus={noop} /></Shell>)
  await kit.sleep(400)
  const region = document.getElementById('bandwidth-apply-status')
  const statusRegionBeforeFailure = region?.getAttribute('role') === 'status' && region.textContent === ''
  presetButton('1 MB/s')?.click()
  await kit.sleep(300)
  const statusRegionHoldsNote = !!region?.isConnected && region.textContent?.includes(RESTART_TEXT) === true
  const workerRejectNoteIsStatus = noteIs('status', RESTART_TEXT)
  const workerRejectNoteIsAlert = noteIs('alert', RESTART_TEXT)
  const workerRejectSaysSaveFailed = kit.alertSays(SAVE_FAILED_TEXT)

  window.bridge.setBandwidth = () => Promise.reject(new Error('config.json is not writable'))
  root.render(<Shell key="bandwidth-persist"><NetworkSettings onBack={noop} onOpenStatus={noop} /></Shell>)
  await kit.sleep(400)
  const askedBefore = kit.asked('settings:set-bandwidth')
  presetButton('5 MB/s')?.click()
  await kit.sleep(300)
  const persistRejectSaysSaveFailed = kit.alertSays(SAVE_FAILED_TEXT)
  const persistRejectAskedWorker = kit.asked('settings:set-bandwidth') - askedBefore

  window.bridge.setBandwidth = (v) => Promise.resolve(v)
  kit.answer('settings:set-bandwidth', 'hold')
  root.render(<Shell key="bandwidth-busy"><NetworkSettings onBack={noop} onOpenStatus={noop} /></Shell>)
  await kit.sleep(400)
  const heldBefore = kit.asked('settings:set-bandwidth')
  presetButton('25 MB/s')?.click()
  await kit.sleep(100)
  const presetsBusyWhileApplying = presetButton('5 MB/s')?.getAttribute('aria-disabled') === 'true'
  presetButton('5 MB/s')?.click()
  await kit.sleep(100)
  const appliesWhileApplying = kit.asked('settings:set-bandwidth') - heldBefore
  kit.releaseHeld()
  await kit.sleep(300)

  kit.answer('settings:set-bandwidth', null)
  root.render(<div key="bandwidth-done" />)
  await kit.sleep(50)
  window.bridge.getBandwidth = realGet
  window.bridge.setBandwidth = realSet
  resetMainStore()
  return {
    statusRegionBeforeFailure, statusRegionHoldsNote,
    workerRejectNoteIsStatus, workerRejectNoteIsAlert, workerRejectSaysSaveFailed,
    persistRejectSaysSaveFailed, persistRejectAskedWorker,
    presetsBusyWhileApplying, appliesWhileApplying, escaped: kit.unhandled() - before,
  }
}

export async function runDroppedProbes(root: Root, kit: FailpathsKit): Promise<DroppedResults> {
  return {
    avatar: await probeAvatar(root, kit),
    onboarding: await probeOnboarding(root, kit),
    audit: await probeAudit(root, kit),
    transfers: await probeTransfers(root, kit),
    relay: await probeRelay(root, kit),
    reconnect: await probeReconnect(root, kit),
    whatsNew: await probeWhatsNew(root, kit),
    bandwidth: await probeBandwidth(root, kit),
  }
}

const busyOk = (b: BusyControl) => b.focusable && b.busy && b.keptFocus

export function droppedOk(r: DroppedResults): boolean {
  const { avatar, onboarding, audit, transfers, relay, reconnect, whatsNew, bandwidth } = r
  return (
    avatar.account && avatar.onboarding && avatar.staleSuccessIgnored && avatar.staleFailureIgnored && avatar.successClearsError &&
    onboarding.alert && onboarding.describedBy && onboarding.keptFocus && onboarding.usable &&
    onboarding.busyWhileSaving && onboarding.callsWhileSaving === 1 &&
    audit.toggleChecked === 'true' && audit.toggleAlert && audit.retentionKept && audit.retentionAlert &&
    audit.busyWhilePatching && audit.sentWhilePatching === 1 && audit.usableAfter &&
    TRANSFER_ACTS.every((act) => transfers.reported[act] && transfers.logged[act]) &&
    Object.values(transfers.transferFallback).every(Boolean) &&
    relay.applyAlert && relay.applyStillArmed && relay.throttleAlert && relay.throttleStillArmed && busyOk(relay.applyBusy) &&
    relay.restartAlert && relay.modeAlert && relay.alwaysAlert && relay.removeAlert &&
    reconnect.alert && reconnect.stillArmed && reconnect.throttleAlert && reconnect.throttleStillArmed && busyOk(reconnect.busy) &&
    whatsNew.failAlert && whatsNew.emptyStatus &&
    bandwidth.statusRegionBeforeFailure && bandwidth.statusRegionHoldsNote && bandwidth.workerRejectNoteIsStatus && !bandwidth.workerRejectNoteIsAlert && !bandwidth.workerRejectSaysSaveFailed &&
    bandwidth.persistRejectSaysSaveFailed && bandwidth.persistRejectAskedWorker === 0 &&
    bandwidth.presetsBusyWhileApplying && bandwidth.appliesWhileApplying === 1
  )
}
