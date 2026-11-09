import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useKeyboard, useRegisterCommand, useRegisterCommands } from '../keyboard/KeyboardProvider.js'
import { spaceDigitAccelerator } from '../keyboard/known-commands.js'
import type { Command, CommandContext, CommandGroup } from '../keyboard/registry.js'
import { docsUrl } from '../shell/docs-links.js'
import { useOpenWhatsNew } from './useOpenWhatsNew.js'
import { useManaged } from './useManaged.js'
import type { AppNavigation } from './useAppNavigation.js'
import type { AppDialog } from '../components/modals/AppDialogs.js'
import type { Space } from '../types/types.js'
import { shortcutOrder } from '../model/space-shortcut-order.js'
import { updateVerdict } from '../model/about-view.js'
import type { Screen } from '../shell/navigation.js'
import { UPDATE_STATE } from '../../shared/contract/update-status.js'
import { checkForUpdate, restartToUpdate } from '../platform/updates.js'
import { exportActivityLog } from './useAuditLog.js'
import { request } from '../ipc/ipc.js'
import { useToast } from '../components/toast/ToastProvider.js'
import { useRunAction } from './useRunAction.js'
import { useUpdates } from './useUpdates.js'
import { useBackupStatus } from './useBackupStatus.js'

interface AppCommandTargets {
  nav: AppNavigation
  canGoBack: boolean
  openDialog: (dialog: AppDialog) => void
  openPalette: () => void
  openCheatsheet: () => void
  openWhatsNew: () => void
  exportLog: () => void
}

interface AppCommandRow {
  id: string
  labelKey: string
  keywordsKey?: string
  group: CommandGroup
  hiddenInPalette?: boolean
  when?: (ctx: CommandContext, targets: AppCommandTargets) => boolean
  run: (targets: AppCommandTargets) => void
}

// The screens no fixed command opens: home has its own command, a space and the organization are
// offered by name, a folder is opened from its space, and the connection problem screen is raised by
// the connection gate. Every other screen needs a row below, or the build fails.
type PaletteScreen = Exclude<Screen, 'spaces' | 'space-view' | 'folder-view' | 'organization' | 'connection-problem'>

const SCREEN_COMMANDS: Record<PaletteScreen, AppCommandRow> = {
  settings: { id: 'settings.open', labelKey: 'shortcuts.openSettings', group: 'navigation', run: (t) => t.nav.openSettings() },
  account: { id: 'profile.open', labelKey: 'shortcuts.openProfile', keywordsKey: 'shortcuts.keywords.profile', group: 'navigation', run: (t) => t.nav.openAccount() },
  about: { id: 'about.open', labelKey: 'shortcuts.openAbout', keywordsKey: 'shortcuts.keywords.about', group: 'navigation', run: (t) => t.nav.setCurrentScreen('about') },
  'activity-log': { id: 'activity.open', labelKey: 'shortcuts.openActivityLog', keywordsKey: 'shortcuts.keywords.activityLog', group: 'navigation', run: (t) => t.nav.openActivityLog() },
  'activity-log-settings': { id: 'activity.openSettings', labelKey: 'shortcuts.openActivityLogSettings', group: 'navigation', run: (t) => t.nav.setCurrentScreen('activity-log-settings') },
  'storage-settings': { id: 'settings.storage', labelKey: 'shortcuts.openStorageSettings', keywordsKey: 'shortcuts.keywords.storage', group: 'navigation', run: (t) => t.nav.openStorageSettings('settings') },
  'appearance-settings': { id: 'settings.appearance', labelKey: 'shortcuts.openAppearanceSettings', keywordsKey: 'shortcuts.keywords.appearance', group: 'navigation', run: (t) => t.nav.setCurrentScreen('appearance-settings') },
  'notification-settings': { id: 'settings.notifications', labelKey: 'shortcuts.openNotificationSettings', group: 'navigation', run: (t) => t.nav.setCurrentScreen('notification-settings') },
  'general-settings': { id: 'settings.general', labelKey: 'shortcuts.openGeneralSettings', keywordsKey: 'shortcuts.keywords.general', group: 'navigation', run: (t) => t.nav.setCurrentScreen('general-settings') },
  'network-settings': { id: 'settings.network', labelKey: 'shortcuts.openNetworkSettings', keywordsKey: 'shortcuts.keywords.networkSettings', group: 'navigation', run: (t) => t.nav.setCurrentScreen('network-settings') },
  'backup-settings': { id: 'settings.backup', labelKey: 'shortcuts.openBackupSettings', keywordsKey: 'shortcuts.keywords.backup', group: 'navigation', run: (t) => t.nav.setCurrentScreen('backup-settings') },
  'network-status': { id: 'network.status', labelKey: 'shortcuts.openNetworkStatus', keywordsKey: 'shortcuts.keywords.networkStatus', group: 'navigation', run: (t) => t.nav.setCurrentScreen('network-status') },
  'network-diagnostics': { id: 'network.diagnostics', labelKey: 'shortcuts.openNetworkDiagnostics', keywordsKey: 'shortcuts.keywords.diagnostics', group: 'navigation', run: (t) => t.nav.setCurrentScreen('network-diagnostics') },
  'network-advanced': { id: 'network.advanced', labelKey: 'shortcuts.openNetworkAdvanced', keywordsKey: 'shortcuts.keywords.networkAdvanced', group: 'navigation', run: (t) => t.nav.setCurrentScreen('network-advanced') },
}

const APP_COMMANDS: readonly AppCommandRow[] = [
  { id: 'nav.back', labelKey: 'shortcuts.back', group: 'navigation', when: (_c, t) => t.canGoBack, run: (t) => t.nav.goBack() },
  { id: 'nav.home', labelKey: 'shortcuts.home', group: 'navigation', when: (c) => c.currentScreen !== 'spaces', run: (t) => t.nav.goHome() },
  { id: 'palette.open', labelKey: 'shortcuts.openPalette', group: 'system', hiddenInPalette: true, run: (t) => t.openPalette() },
  { id: 'shortcuts.show', labelKey: 'shortcuts.showShortcuts', keywordsKey: 'shortcuts.keywords.shortcuts', group: 'system', run: (t) => t.openCheatsheet() },
  ...Object.values(SCREEN_COMMANDS),
  { id: 'network.history', labelKey: 'shortcuts.showConnectionHistory', keywordsKey: 'shortcuts.keywords.connectionHistory', group: 'navigation', run: (t) => t.nav.openActivityLog({ categories: ['network'] }) },
  { id: 'space.new', labelKey: 'shortcuts.newSpace', group: 'actions', run: (t) => t.openDialog({ kind: 'create' }) },
  { id: 'space.join', labelKey: 'shortcuts.joinSpace', group: 'actions', run: (t) => t.openDialog({ kind: 'join' }) },
  { id: 'activity.export', labelKey: 'shortcuts.exportActivityLog', keywordsKey: 'shortcuts.keywords.exportActivityLog', group: 'actions', run: (t) => t.exportLog() },
  { id: 'help.whatsNew', labelKey: 'shortcuts.whatsNew', group: 'system', run: (t) => t.openWhatsNew() },
  { id: 'help.feedback', labelKey: 'shortcuts.sendFeedback', keywordsKey: 'shortcuts.keywords.feedback', group: 'system', run: (t) => t.openDialog({ kind: 'feedback' }) },
  { id: 'help.docs', labelKey: 'shortcuts.openDocs', keywordsKey: 'shortcuts.keywords.docs', group: 'system', run: () => { window.open(docsUrl({ page: 'hub' }), '_blank', 'noopener') } },
]

function toCommand(row: AppCommandRow, targets: AppCommandTargets): Command {
  const { when } = row
  return {
    id: row.id,
    labelKey: row.labelKey,
    keywordsKey: row.keywordsKey,
    group: row.group,
    hiddenInPalette: row.hiddenInPalette,
    when: when ? (ctx) => when(ctx, targets) : undefined,
    run: () => row.run(targets),
  }
}

// Every space is reachable by name in the palette. The first nine favorites also carry their ⌘1-9
// chord, but only as a label: the binding itself lives in the native Go-to-Favorite menu, because
// Chromium claims the digit chords before the renderer can see them.
function spaceOpenCommand(space: Space, accelerator: string | undefined, nav: AppNavigation): Command {
  return {
    id: `space.open.${space.spaceId}`,
    labelKey: 'shortcuts.openSpace',
    labelParams: { name: space.name },
    group: 'navigation',
    accelerator,
    run: () => nav.navigateToSpace(space.spaceId),
  }
}

// Mouse "back" side button (button 3), the OS-consistent back gesture. The Windows browser-backward
// app-command and the macOS trackpad swipe arrive from the main process as a 'nav.back' command.
function useMouseBackButton(runCommand: (id: string) => void): void {
  useEffect(() => {
    const onMouseUp = (e: MouseEvent): void => {
      if (e.button !== 3) return
      e.preventDefault()
      runCommand('nav.back')
    }
    window.addEventListener('mouseup', onMouseUp)
    return () => window.removeEventListener('mouseup', onMouseUp)
  }, [runCommand])
}

interface AppCommandsArgs {
  nav: AppNavigation
  spaces: Space[]
  canGoBack: boolean
  openDialog: (dialog: AppDialog) => void
}

export function useAppCommands({ nav, spaces, canGoBack, openDialog }: AppCommandsArgs): void {
  const { openPalette, openCheatsheet, runCommand } = useKeyboard()
  const openWhatsNew = useOpenWhatsNew()
  const exportLog = useExportLog()
  const targets: AppCommandTargets = { nav, canGoBack, openDialog, openPalette, openCheatsheet, openWhatsNew, exportLog }
  useRegisterCommands(APP_COMMANDS.map((row) => toCommand(row, targets)), [])
  useRegisterCommands([
    ...shortcutOrder(spaces).map((space, i) => spaceOpenCommand(space, spaceDigitAccelerator(i), nav)),
    ...spaces.filter((space) => !space.favorite).map((space) => spaceOpenCommand(space, undefined, nav)),
  ], [spaces])
  useOrganizationCommand(nav)
  useUpdateCommands(nav)
  useBackupCommand(nav)
  useMouseBackButton(runCommand)
}

function useExportLog(): () => void {
  const { t } = useTranslation()
  const toast = useToast()
  const runAction = useRunAction()
  return () => runAction(async () => {
    toast.success(t('activityLogSettings.exportDone', { count: await exportActivityLog() }))
  })
}

// Offered when About would offer the same action. A check opens About, where its verdict shows.
function useUpdateCommands(nav: AppNavigation): void {
  const runAction = useRunAction()
  const { status } = useUpdates()
  const action = updateVerdict(status).action
  useRegisterCommands([
    {
      id: 'update.check',
      labelKey: 'shortcuts.checkForUpdates',
      keywordsKey: 'shortcuts.keywords.checkForUpdates',
      group: 'system',
      when: () => action === 'check',
      run: () => {
        nav.setCurrentScreen('about')
        if (status.state !== UPDATE_STATE.CHECKING) runAction(checkForUpdate)
      },
    },
    {
      id: 'update.restart',
      labelKey: 'shortcuts.restartToUpdate',
      keywordsKey: 'shortcuts.keywords.restartToUpdate',
      group: 'system',
      when: () => action === 'restart',
      run: () => runAction(restartToUpdate),
    },
  ], [action])
}

// Offered while a set-up backup is neither running nor held by a restore. It opens the backup
// screen, where the run's progress and outcome show.
function useBackupCommand(nav: AppNavigation): void {
  const runAction = useRunAction()
  const status = useBackupStatus()
  const canRun = !!status?.folder && (status.state === 'idle' || status.state === 'error')
  useRegisterCommand({
    id: 'backup.run',
    labelKey: 'shortcuts.backUpNow',
    keywordsKey: 'shortcuts.keywords.backUpNow',
    group: 'actions',
    when: () => canRun,
    run: () => {
      nav.setCurrentScreen('backup-settings')
      runAction(async () => { await request('backup:run', {}, 0) })
    },
  }, [canRun])
}

// Offered only while an organization manages this install, under its name, so the name finds it.
function useOrganizationCommand(nav: AppNavigation): void {
  const org = useManaged()?.organization.name ?? null
  useRegisterCommand({
    id: 'organization.open',
    labelKey: 'shortcuts.openOrganization',
    labelParams: { org: org ?? '' },
    group: 'navigation',
    when: () => org !== null,
    run: () => nav.setCurrentScreen('organization'),
  }, [org])
}
