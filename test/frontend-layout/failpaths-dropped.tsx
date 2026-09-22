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
import type { FileEntry, Profile } from '../../src/renderer/types/types.js'

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }
export type WorkerAnswer = 'fail' | 'hold' | { data: Json }

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
}

interface AvatarProbe { account: boolean; onboarding: boolean; escaped: number }
interface OnboardingProbe {
  alert: boolean; describedBy: boolean; keptFocus: boolean; usable: boolean
  busyWhileSaving: boolean; callsWhileSaving: number; escaped: number
}
interface AuditProbe { toggleChecked: string | null; toggleAlert: boolean; retentionKept: boolean; retentionAlert: boolean; busyWhilePatching: boolean; sentWhilePatching: number; usableAfter: boolean; escaped: number }
interface RelayProbe { applyAlert: boolean; applyStillArmed: boolean; restartAlert: boolean; escaped: number }
interface ReconnectProbe { alert: boolean; stillArmed: boolean; escaped: number }
interface WhatsNewProbe { failAlert: boolean; emptyStatus: boolean; escaped: number }
interface BandwidthProbe { workerRejectSaysRestart: boolean; workerRejectSaysSaveFailed: boolean; persistRejectSaysSaveFailed: boolean; persistRejectAskedWorker: number; escaped: number }

export interface DroppedResults {
  avatar: AvatarProbe
  onboarding: OnboardingProbe
  audit: AuditProbe
  transfers: { reported: Record<string, boolean>; escaped: number }
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

const noop = () => {}

const statusSays = (text: string) =>
  Array.from(document.querySelectorAll('[role="status"]')).some((n) => n.textContent?.includes(text))

// Enough of a network status frame for the screens to render a verdict that offers Reconnect, and a
// relayed connection the relay notice counts as stale.
const OFFLINE_STATUS: Json = {
  state: 'offline', dhtReady: true, announced: false, peerCount: 0, connecting: 0, suspended: false,
  lastConnectionAt: null, bootedAt: 0,
  identity: { publicKey: 'p'.repeat(64), nodeId: null },
  address: { publicHost: null, publicPort: 0, localPort: 0 },
  nat: { firewalled: null, randomized: null, ephemeral: false },
  routing: { bootstrap: [], tableSize: 0 },
  topics: 0,
  peerReach: { discovered: 0, connected: 0 },
  canary: { state: 'unavailable', at: null },
  relay: { connections: [{ via: 'own', relayMode: 'auto', replaced: false }], direct: { control: 0, content: 0 } },
  reachability: { verdict: 'offline', cause: 'generic' },
  versions: { dht: '0' },
}

// A picked file whose bytes no image decoder accepts.
async function pickBrokenImage(kit: FailpathsKit): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')
  if (!input) return
  const dt = new DataTransfer()
  dt.items.add(new File([new Uint8Array([1, 2, 3, 4])], 'broken.png', { type: 'image/png' }))
  input.files = dt.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
  await kit.sleep(400)
}

async function probeAvatar(root: Root, kit: FailpathsKit): Promise<AvatarProbe> {
  const { Shell } = kit
  const before = kit.unhandled()
  root.render(
    <Shell key="avatar-account">
      <Account profile={kit.profile} onSave={() => Promise.resolve()} onBack={noop} onOpenNetworkStatus={noop} onOpenActivityLog={noop} onFeedback={noop} />
    </Shell>,
  )
  await kit.sleep(300)
  await pickBrokenImage(kit)
  const account = kit.alertSays(AVATAR_UNREADABLE_TEXT)

  root.render(<OnboardingScreen key="avatar-onboarding" onComplete={() => Promise.resolve()} />)
  await kit.sleep(300)
  await pickBrokenImage(kit)
  return { account, onboarding: kit.alertSays(AVATAR_UNREADABLE_TEXT), escaped: kit.unhandled() - before }
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
  driveKey: 'd'.repeat(64), localBytes: 0, isAvailable: true, status: 'remote',
}

const TRANSFER_FAILS = [
  'files:cancel-download', 'files:pause-download', 'share:read-file', 'share:reveal-file',
  'share:discard-partial', 'files:download', 'files:discard-partial',
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
    'folder-discard': () => { share.discardPartial('a.bin') },
    'space-download': () => { loose.downloadFile(LOOSE_FILE) },
    'space-discard': () => { loose.discardPartial(LOOSE_FILE) },
  }
  return <button type="button" onClick={acts[only]}>{`act ${only}`}</button>
}

const TRANSFER_ACTS = ['cancel', 'pause', 'folder-download', 'folder-reveal', 'folder-discard', 'space-download', 'space-discard']

async function probeTransfers(root: Root, kit: FailpathsKit): Promise<DroppedResults['transfers']> {
  const { Shell } = kit
  const before = kit.unhandled()
  for (const type of TRANSFER_FAILS) kit.answer(type, 'fail')
  const reported: Record<string, boolean> = {}
  for (const act of TRANSFER_ACTS) {
    root.render(<Shell key={`transfer-${act}`}><TransferControls only={act} /></Shell>)
    await kit.sleep(200)
    kit.buttonWithText(`act ${act}`)?.click()
    await kit.sleep(300)
    reported[act] = kit.alertSays(kit.unavailableText)
  }
  for (const type of TRANSFER_FAILS) kit.answer(type, null)
  return { reported, escaped: kit.unhandled() - before }
}

async function probeRelay(root: Root, kit: FailpathsKit): Promise<RelayProbe> {
  const { Shell } = kit
  const before = kit.unhandled()
  kit.answer('network:status:get', { data: OFFLINE_STATUS })
  kit.answer('network:reconnect', 'fail')
  setApplyArmed(true)
  root.render(<Shell key="relay-apply"><RelaySettingsSection /></Shell>)
  await kit.sleep(400)
  kit.buttonWithText(RECONNECT_NOW)?.click()
  await kit.sleep(300)
  const applyAlert = kit.alertSays(kit.unavailableText)
  const applyStillArmed = isApplyArmed()
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
  return { applyAlert, applyStillArmed, restartAlert, escaped: kit.unhandled() - before }
}

// The reconnect is what applies an armed relay change, so a refused one leaves it armed.
async function probeReconnect(root: Root, kit: FailpathsKit): Promise<ReconnectProbe> {
  const { Shell } = kit
  const before = kit.unhandled()
  kit.answer('network:status:get', { data: OFFLINE_STATUS })
  kit.answer('network:reconnect', 'fail')
  setApplyArmed(true)
  root.render(
    <Shell key="network-status">
      <NetworkStatusScreen onBack={noop} onShowHistory={noop} onOpenSettings={noop} onOpenDiagnostics={noop} onOpenAdvanced={noop} />
    </Shell>,
  )
  await kit.sleep(400)
  document.querySelector<HTMLButtonElement>('button[aria-label="Reconnect"]')?.click()
  await kit.sleep(300)
  const result = { alert: kit.alertSays(kit.unavailableText), stillArmed: isApplyArmed(), escaped: kit.unhandled() - before }
  setApplyArmed(false)
  kit.answer('network:reconnect', null)
  kit.answer('network:status:get', null)
  return result
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

// Persist first, then the worker: the worker boots from the persisted value, so a worker refusal
// means "saved, applies after a restart", and a persist refusal means nothing changed anywhere.
async function probeBandwidth(root: Root, kit: FailpathsKit): Promise<BandwidthProbe> {
  const { Shell } = kit
  const before = kit.unhandled()
  window.bridge.getBandwidth = () => Promise.resolve({ downloadKBps: 0, uploadKBps: 0 })
  window.bridge.setBandwidth = (v) => Promise.resolve(v)
  kit.answer('settings:set-bandwidth', 'fail')
  root.render(<Shell key="bandwidth-worker"><NetworkSettings onBack={noop} onOpenStatus={noop} /></Shell>)
  await kit.sleep(400)
  document.querySelector<HTMLButtonElement>('button[aria-label="Download limit: 1 MB/s"]')?.click()
  await kit.sleep(300)
  const workerRejectSaysRestart = kit.alertSays(RESTART_TEXT)
  const workerRejectSaysSaveFailed = kit.alertSays(SAVE_FAILED_TEXT)

  window.bridge.setBandwidth = () => Promise.reject(new Error('config.json is not writable'))
  root.render(<Shell key="bandwidth-persist"><NetworkSettings onBack={noop} onOpenStatus={noop} /></Shell>)
  await kit.sleep(400)
  const askedBefore = kit.asked('settings:set-bandwidth')
  document.querySelector<HTMLButtonElement>('button[aria-label="Download limit: 5 MB/s"]')?.click()
  await kit.sleep(300)
  const persistRejectSaysSaveFailed = kit.alertSays(SAVE_FAILED_TEXT)
  const persistRejectAskedWorker = kit.asked('settings:set-bandwidth') - askedBefore
  kit.answer('settings:set-bandwidth', null)
  return { workerRejectSaysRestart, workerRejectSaysSaveFailed, persistRejectSaysSaveFailed, persistRejectAskedWorker, escaped: kit.unhandled() - before }
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

export function droppedOk(r: DroppedResults): boolean {
  const { avatar, onboarding, audit, transfers, relay, reconnect, whatsNew, bandwidth } = r
  return (
    avatar.account && avatar.onboarding &&
    onboarding.alert && onboarding.describedBy && onboarding.keptFocus && onboarding.usable &&
    onboarding.busyWhileSaving && onboarding.callsWhileSaving === 1 &&
    audit.toggleChecked === 'true' && audit.toggleAlert && audit.retentionKept && audit.retentionAlert &&
    audit.busyWhilePatching && audit.sentWhilePatching === 1 && audit.usableAfter &&
    TRANSFER_ACTS.every((act) => transfers.reported[act]) &&
    relay.applyAlert && relay.applyStillArmed && relay.restartAlert &&
    reconnect.alert && reconnect.stillArmed &&
    whatsNew.failAlert && whatsNew.emptyStatus &&
    bandwidth.workerRejectSaysRestart && !bandwidth.workerRejectSaysSaveFailed &&
    bandwidth.persistRejectSaysSaveFailed && bandwidth.persistRejectAskedWorker === 0
  )
}
