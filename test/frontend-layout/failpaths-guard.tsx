// The sites the renderer promise lint found still dropping a failure after #446's first pass. Each
// probe fails one action under the real control and asserts the failure is said and nothing escapes.
import type { Root } from 'react-dom/client'
import { ToastProvider } from '../../src/renderer/components/toast/ToastProvider.js'
import { KeyboardProvider, useKeyboard } from '../../src/renderer/keyboard/KeyboardProvider.js'
import { ConnectionStatusProvider } from '../../src/renderer/hooks/useConnectionStatus.js'
import { useSpaceCommands } from '../../src/renderer/hooks/useSpaceCommands.js'
import DeleteFolderShareModal from '../../src/renderer/components/modals/DeleteFolderShareModal.js'
import GeneralSettings from '../../src/renderer/screens/settings/GeneralSettings.js'
import AppearanceSettings from '../../src/renderer/screens/settings/AppearanceSettings.js'
import RelaySettingsSection from '../../src/renderer/screens/settings/RelaySettingsSection.js'
import { setRelay, type RelaySlot } from '../../src/renderer/platform/config-client.js'
import { resetMainStore } from '../../src/renderer/store/main-store.js'
import type { AppNavigation } from '../../src/renderer/hooks/useAppNavigation.js'
import type { Space } from '../../src/renderer/types/types.js'
import type { FailpathsKit } from './failpaths-dropped.js'

export interface GuardResults {
  deleteShare: { alert: boolean; stillOpen: boolean }
  prefs: { minimizeAlert: boolean; loginAlert: boolean; menuBarAlert: boolean }
  zoom: { alert: boolean }
  favorite: { alert: boolean }
  relayTest: { alert: boolean }
  escaped: number
}

const noop = () => {}
const GENERIC_TEXT = 'Something went wrong'

const switchLabelled = (text: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('[role="switch"]')).find((sw) =>
    document.getElementById(sw.getAttribute('aria-labelledby') ?? '')?.textContent?.includes(text),
  ) ?? null

async function probeDeleteShare(root: Root, kit: FailpathsKit): Promise<GuardResults['deleteShare']> {
  const { Shell } = kit
  root.render(
    <Shell key="guard-delete-share">
      <DeleteFolderShareModal isOpen folderName="Docs" spaceName="Team" onClose={noop} onDelete={kit.rejectsUnavailable} />
    </Shell>,
  )
  await kit.sleep(300)
  const dialog = document.querySelector('[role="alertdialog"]')
  if (dialog) kit.buttonWithText('Delete Folder', dialog)?.click()
  await kit.sleep(300)
  return { alert: kit.alertSays(kit.unavailableText), stillOpen: !!document.querySelector('[role="alertdialog"]') }
}

async function toggleFails(root: Root, kit: FailpathsKit, key: string, screen: 'general' | 'appearance', label: string): Promise<boolean> {
  const { Shell } = kit
  resetMainStore()
  root.render(
    <Shell key={key}>
      {screen === 'general' ? <GeneralSettings onBack={noop} /> : <AppearanceSettings onBack={noop} />}
    </Shell>,
  )
  await kit.sleep(300)
  switchLabelled(label)?.click()
  await kit.sleep(300)
  return kit.alertSays(kit.unavailableText)
}

async function probePrefs(root: Root, kit: FailpathsKit): Promise<GuardResults['prefs']> {
  const realGet = window.bridge.getPrefs
  const realSet = window.bridge.setPrefs
  const realPlatform = window.bridge.getPlatform
  window.bridge.getPrefs = () => Promise.resolve({ minimizeToTray: true, openAtLogin: false, appMenuAutoHide: false })
  window.bridge.setPrefs = kit.rejectsUnavailable
  const minimizeAlert = await toggleFails(root, kit, 'guard-minimize', 'general', 'Show Mirall in the menu bar')
  const loginAlert = await toggleFails(root, kit, 'guard-login', 'general', 'Launch at login')
  window.bridge.getPlatform = () => 'linux'
  const menuBarAlert = await toggleFails(root, kit, 'guard-menubar', 'appearance', 'Auto-hide the menu bar')
  window.bridge.getPlatform = realPlatform
  window.bridge.getPrefs = realGet
  window.bridge.setPrefs = realSet
  resetMainStore()
  return { minimizeAlert, loginAlert, menuBarAlert }
}

async function probeZoom(root: Root, kit: FailpathsKit): Promise<GuardResults['zoom']> {
  const { Shell } = kit
  const realSet = window.bridge.setZoom
  window.bridge.setZoom = kit.rejectsUnavailable
  resetMainStore()
  root.render(<Shell key="guard-zoom"><AppearanceSettings onBack={noop} /></Shell>)
  await kit.sleep(300)
  kit.buttonWithText('Spacious')?.click()
  await kit.sleep(300)
  const alert = kit.alertSays(kit.unavailableText)
  window.bridge.setZoom = realSet
  resetMainStore()
  return { alert }
}

const SPACE = { spaceId: 'space1', name: 'Team', status: 'joined', favorite: false } as Space

function FavoriteCommand({ toggleFavorite }: { toggleFavorite: (spaceId: string) => Promise<void> }) {
  useSpaceCommands({ nav: {} as AppNavigation, spaces: [SPACE], toggleFavorite })
  const { runCommand } = useKeyboard()
  return <button type="button" onClick={() => runCommand('space.favorite')}>run favorite</button>
}

async function probeFavorite(root: Root, kit: FailpathsKit): Promise<GuardResults['favorite']> {
  root.render(
    <ToastProvider key="guard-favorite">
      <ConnectionStatusProvider>
        <KeyboardProvider currentScreen="space-view" selectedSpaceId="space1">
          <FavoriteCommand toggleFavorite={kit.rejectsUnavailable} />
        </KeyboardProvider>
      </ConnectionStatusProvider>
    </ToastProvider>,
  )
  await kit.sleep(300)
  kit.buttonWithText('run favorite')?.click()
  await kit.sleep(300)
  return { alert: kit.alertSays(kit.unavailableText) }
}

const SLOT: RelaySlot = { publicKey: 'r'.repeat(64), kind: 'open', label: 'Test relay', enabled: true, lastTest: { at: 1, ok: true } }

// The probe itself answers; recording its verdict is the write that fails.
async function probeRelayTest(root: Root, kit: FailpathsKit): Promise<GuardResults['relayTest']> {
  const { Shell } = kit
  const realSetRelay = window.bridge.setRelay
  window.bridge.setRelay = () => Promise.resolve({ ok: true, network: { downloadKBps: 0, uploadKBps: 0, relayMode: 'auto', relay: SLOT }, identityChanged: false })
  await setRelay({ mode: 'auto' })
  kit.answer('network:test-relay', { data: { ok: true } })
  root.render(<Shell key="guard-relay-test"><RelaySettingsSection /></Shell>)
  await kit.sleep(300)
  window.bridge.setRelay = () => Promise.reject(new Error('the relay vault is locked'))
  document.querySelector<HTMLButtonElement>('button[aria-label="Options for Test relay"]')?.click()
  await kit.sleep(200)
  Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((i) => i.textContent?.trim() === 'Test')?.click()
  await kit.sleep(400)
  const alert = kit.alertSays(GENERIC_TEXT)
  kit.answer('network:test-relay', null)
  window.bridge.setRelay = () => Promise.resolve({ ok: true, network: { downloadKBps: 0, uploadKBps: 0, relayMode: 'off', relay: null }, identityChanged: false })
  await setRelay({ mode: 'off' })
  window.bridge.setRelay = realSetRelay
  return { alert }
}

export async function runGuardProbes(root: Root, kit: FailpathsKit): Promise<GuardResults> {
  const before = kit.unhandled()
  const deleteShare = await probeDeleteShare(root, kit)
  const prefs = await probePrefs(root, kit)
  const zoom = await probeZoom(root, kit)
  const favorite = await probeFavorite(root, kit)
  const relayTest = await probeRelayTest(root, kit)
  return { deleteShare, prefs, zoom, favorite, relayTest, escaped: kit.unhandled() - before }
}

export function guardOk(r: GuardResults): boolean {
  return (
    r.deleteShare.alert && r.deleteShare.stillOpen &&
    r.prefs.minimizeAlert && r.prefs.loginAlert && r.prefs.menuBarAlert &&
    r.zoom.alert && r.favorite.alert && r.relayTest.alert &&
    r.escaped === 0
  )
}
