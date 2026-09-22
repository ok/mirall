// A write behind a settings control, a destructive confirm or a keyboard command that rejects is
// said, the dialog it came from stays open, and nothing escapes. Each probe fails one action under
// the real control.
import type { Root } from 'react-dom/client'
import { ToastProvider } from '../../src/renderer/components/toast/ToastProvider.js'
import { KeyboardProvider, useKeyboard } from '../../src/renderer/keyboard/KeyboardProvider.js'
import { ConnectionStatusProvider } from '../../src/renderer/hooks/useConnectionStatus.js'
import { useSpaceCommands } from '../../src/renderer/hooks/useSpaceCommands.js'
import DeleteFolderShareModal from '../../src/renderer/components/modals/DeleteFolderShareModal.js'
import GeneralSettings from '../../src/renderer/screens/settings/GeneralSettings.js'
import AppearanceSettings from '../../src/renderer/screens/settings/AppearanceSettings.js'
import RelaySettingsSection from '../../src/renderer/screens/settings/RelaySettingsSection.js'
import FolderScreen from '../../src/renderer/screens/FolderScreen.js'
import NotificationSettings from '../../src/renderer/screens/settings/NotificationSettings.js'
import i18n from '../../src/renderer/platform/i18n.js'
import ConnectionProblemScreen from '../../src/renderer/screens/ConnectionProblemScreen.js'
import type { ShareWithRole } from '../../src/renderer/hooks/useShares.js'
import { setRelay, type RelaySlot } from '../../src/renderer/platform/config-client.js'
import { resetMainStore } from '../../src/renderer/store/main-store.js'
import type { AppNavigation } from '../../src/renderer/hooks/useAppNavigation.js'
import type { Space } from '../../src/renderer/types/types.js'
import { OFFLINE_STATUS, type FailpathsKit } from './failpaths-dropped.js'

export interface GuardResults {
  deleteShare: { alert: boolean; closed: number }
  folderDelete: { alert: boolean; stillOpen: boolean; wentBack: boolean }
  checkAgain: { alert: boolean }
  prefs: { minimizeAlert: boolean; loginAlert: boolean; menuBarAlert: boolean }
  zoom: { alert: boolean }
  favorite: { alert: boolean }
  relayTest: { alert: boolean }
  configWrites: { notifyAlert: boolean; notifyRestored: boolean; themeAlert: boolean; themeRestored: boolean; localeAlert: boolean; localeRestored: boolean }
  escaped: number
}

const noop = () => {}
const GENERIC_TEXT = 'Something went wrong'

const switchLabelled = (text: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('[role="switch"]')).find((sw) =>
    document.getElementById(sw.getAttribute('aria-labelledby') ?? '')?.textContent?.includes(text),
  ) ?? null

const confirmDelete = (kit: FailpathsKit) => {
  const dialog = document.querySelector('[role="alertdialog"]')
  if (dialog) kit.buttonWithText('Delete Folder', dialog)?.click()
}

// REGRESSION (FIX-446: Delete Folder from a space card dropped the refusal)
async function probeDeleteShare(root: Root, kit: FailpathsKit): Promise<GuardResults['deleteShare']> {
  const { Shell } = kit
  let closed = 0
  root.render(
    <Shell key="guard-delete-share">
      <DeleteFolderShareModal isOpen folderName="Docs" spaceName="Team" onClose={() => { closed += 1 }} onDelete={kit.rejectsUnavailable} />
    </Shell>,
  )
  await kit.sleep(300)
  confirmDelete(kit)
  await kit.sleep(300)
  return { alert: kit.alertSays(kit.unavailableText), closed }
}

const OWN_SHARE: ShareWithRole = {
  id: 'share1', type: 'owned-folder', name: 'Photos', owner: 'ownerkey', spaceId: 'space1', createdAt: 0,
  role: 'mine', mountStatus: 'ok', mirrorEnabled: true,
}

// REGRESSION (FIX-446: the folder screen closed its delete dialog over a refused delete)
async function probeFolderDelete(root: Root, kit: FailpathsKit): Promise<GuardResults['folderDelete']> {
  const { Shell } = kit
  let wentBack = false
  kit.answer('owned-folder:delete', 'fail')
  root.render(<Shell key="guard-folder-delete"><FolderScreen spaceId="space1" share={OWN_SHARE} onBack={() => { wentBack = true }} /></Shell>)
  await kit.sleep(400)
  document.querySelector<HTMLButtonElement>('button[aria-label="More"]')?.click()
  await kit.sleep(200)
  Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((i) => i.textContent?.includes('Delete Folder'))?.click()
  await kit.sleep(300)
  confirmDelete(kit)
  await kit.sleep(300)
  kit.answer('owned-folder:delete', null)
  return { alert: kit.alertSays(kit.unavailableText), stillOpen: !!document.querySelector('[role="alertdialog"]'), wentBack }
}

// REGRESSION (FIX-446: Check again on the connection problem screen said nothing when the check failed)
async function probeCheckAgain(root: Root, kit: FailpathsKit): Promise<GuardResults['checkAgain']> {
  const { Shell } = kit
  kit.answer('network:status:get', { data: { ...OFFLINE_STATUS, reachability: { verdict: 'blocked', cause: 'generic' } } })
  kit.answer('network:probe-canary', 'fail')
  root.render(<Shell key="guard-check-again"><ConnectionProblemScreen onContinue={noop} onShowDetails={noop} onShowHistory={noop} /></Shell>)
  await kit.sleep(300)
  kit.buttonWithText('Check again')?.click()
  await kit.sleep(300)
  kit.answer('network:probe-canary', null)
  kit.answer('network:status:get', null)
  return { alert: kit.alertSays(kit.unavailableText) }
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

// REGRESSION (FIX-446: the General and Appearance toggles dropped a refused prefs write)
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

// REGRESSION (FIX-446: choosing a display size dropped a refused zoom write)
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

// REGRESSION (FIX-446: the favorite shortcut dropped a refused toggle)
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

// REGRESSION (FIX-446: a relay test dropped the refused write of its verdict). The probe itself
// answers; recording its verdict is the write that fails.
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

const anyAlert = () => document.querySelectorAll('[role="alert"]').length > 0

// REGRESSION (FIX-446: notification, theme and language choices dropped a refused config write and
// kept showing a value main never stored)
async function probeConfigWrites(root: Root, kit: FailpathsKit): Promise<GuardResults['configWrites']> {
  const { Shell } = kit
  const realGetConfig = window.bridge.getConfig
  const realSetConfig = window.bridge.setConfig
  const realSetTheme = window.bridge.setTheme
  // What main holds: nothing the refused writes asked for.
  window.bridge.getConfig = () => ({
    appearance: { theme: 'system', locale: 'en' },
    notifications: null,
    ui: { lastSeenVersion: null, feedbackEmail: '' },
    network: { downloadKBps: 0, uploadKBps: 0, relayMode: 'off', relay: null },
    features: {},
  })
  window.bridge.setConfig = kit.rejectsUnavailable
  window.bridge.setTheme = kit.rejectsUnavailable

  root.render(<Shell key="guard-notify"><NotificationSettings onBack={noop} /></Shell>)
  await kit.sleep(300)
  const before = switchLabelled('Show desktop notifications')?.getAttribute('aria-checked')
  switchLabelled('Show desktop notifications')?.click()
  await kit.sleep(300)
  const notifyAlert = kit.alertSays(kit.unavailableText)
  const notifyRestored = switchLabelled('Show desktop notifications')?.getAttribute('aria-checked') === before

  root.render(<Shell key="guard-theme"><AppearanceSettings onBack={noop} /></Shell>)
  await kit.sleep(300)
  const pressed = () => Array.from(document.querySelectorAll('button[aria-pressed="true"]')).map((b) => b.textContent ?? '')
  const pressedBefore = pressed()
  const darkBefore = document.documentElement.classList.contains('dark')
  kit.buttonWithText(darkBefore ? 'Light' : 'Dark')?.click()
  await kit.sleep(300)
  const themeAlert = kit.alertSays(kit.unavailableText)
  // The harness boots on the System theme, so the painted scheme goes back to the OS's.
  const themeRestored = document.documentElement.classList.contains('dark') === window.matchMedia('(prefers-color-scheme: dark)').matches &&
    JSON.stringify(pressed()) === JSON.stringify(pressedBefore)

  root.render(<Shell key="guard-locale"><AppearanceSettings onBack={noop} /></Shell>)
  await kit.sleep(300)
  kit.buttonWithText('Deutsch')?.click()
  await kit.sleep(400)
  const localeAlert = anyAlert()
  const localeRestored = i18n.language === 'en' && document.documentElement.lang === 'en'
  await i18n.changeLanguage('en')

  window.bridge.getConfig = realGetConfig
  window.bridge.setConfig = realSetConfig
  window.bridge.setTheme = realSetTheme
  return { notifyAlert, notifyRestored, themeAlert, themeRestored, localeAlert, localeRestored }
}

export async function runGuardProbes(root: Root, kit: FailpathsKit): Promise<GuardResults> {
  const before = kit.unhandled()
  const deleteShare = await probeDeleteShare(root, kit)
  const folderDelete = await probeFolderDelete(root, kit)
  const checkAgain = await probeCheckAgain(root, kit)
  const prefs = await probePrefs(root, kit)
  const zoom = await probeZoom(root, kit)
  const favorite = await probeFavorite(root, kit)
  const relayTest = await probeRelayTest(root, kit)
  const configWrites = await probeConfigWrites(root, kit)
  return { deleteShare, folderDelete, checkAgain, prefs, zoom, favorite, relayTest, configWrites, escaped: kit.unhandled() - before }
}

export function guardOk(r: GuardResults): boolean {
  return (
    r.deleteShare.alert && r.deleteShare.closed === 0 &&
    r.folderDelete.alert && r.folderDelete.stillOpen && !r.folderDelete.wentBack &&
    r.checkAgain.alert &&
    r.prefs.minimizeAlert && r.prefs.loginAlert && r.prefs.menuBarAlert &&
    r.zoom.alert && r.favorite.alert && r.relayTest.alert &&
    Object.values(r.configWrites).every(Boolean) &&
    r.escaped === 0
  )
}
