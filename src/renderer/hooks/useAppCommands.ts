import { useEffect } from 'react'
import { useKeyboard, useRegisterCommands } from '../keyboard/KeyboardProvider.js'
import { spaceDigitAccelerator } from '../keyboard/known-commands.js'
import type { Command, CommandContext, CommandGroup } from '../keyboard/registry.js'
import { docsUrl } from '../shell/docs-links.js'
import { useOpenWhatsNew } from './useOpenWhatsNew.js'
import type { AppNavigation } from './useAppNavigation.js'
import type { AppDialog } from '../components/modals/AppDialogs.js'
import type { Space } from '../types/types.js'

interface AppCommandTargets {
  nav: AppNavigation
  canGoBack: boolean
  openDialog: (dialog: AppDialog) => void
  openPalette: () => void
  openCheatsheet: () => void
  openWhatsNew: () => void
}

interface AppCommandRow {
  id: string
  labelKey: string
  group: CommandGroup
  hiddenInPalette?: boolean
  when?: (ctx: CommandContext, targets: AppCommandTargets) => boolean
  run: (targets: AppCommandTargets) => void
}

const APP_COMMANDS: readonly AppCommandRow[] = [
  { id: 'nav.back', labelKey: 'shortcuts.back', group: 'navigation', when: (_c, t) => t.canGoBack, run: (t) => t.nav.goBack() },
  { id: 'nav.home', labelKey: 'shortcuts.home', group: 'navigation', when: (c) => c.currentScreen !== 'spaces', run: (t) => t.nav.goHome() },
  { id: 'palette.open', labelKey: 'shortcuts.openPalette', group: 'system', hiddenInPalette: true, run: (t) => t.openPalette() },
  { id: 'shortcuts.show', labelKey: 'shortcuts.showShortcuts', group: 'system', run: (t) => t.openCheatsheet() },
  { id: 'settings.open', labelKey: 'shortcuts.openSettings', group: 'navigation', run: (t) => t.nav.openSettings() },
  { id: 'profile.open', labelKey: 'shortcuts.openProfile', group: 'navigation', run: (t) => t.nav.openAccount() },
  { id: 'activity.open', labelKey: 'shortcuts.openActivityLog', group: 'navigation', run: (t) => t.nav.openActivityLog() },
  { id: 'activity.openSettings', labelKey: 'shortcuts.openActivityLogSettings', group: 'navigation', run: (t) => t.nav.setCurrentScreen('activity-log-settings') },
  { id: 'settings.storage', labelKey: 'shortcuts.openStorageSettings', group: 'navigation', run: (t) => t.nav.openStorageSettings('settings') },
  { id: 'settings.appearance', labelKey: 'shortcuts.openAppearanceSettings', group: 'navigation', run: (t) => t.nav.setCurrentScreen('appearance-settings') },
  { id: 'settings.notifications', labelKey: 'shortcuts.openNotificationSettings', group: 'navigation', run: (t) => t.nav.setCurrentScreen('notification-settings') },
  { id: 'settings.general', labelKey: 'shortcuts.openGeneralSettings', group: 'navigation', run: (t) => t.nav.setCurrentScreen('general-settings') },
  { id: 'settings.network', labelKey: 'shortcuts.openNetworkSettings', group: 'navigation', run: (t) => t.nav.setCurrentScreen('network-settings') },
  { id: 'network.status', labelKey: 'shortcuts.openNetworkStatus', group: 'navigation', run: (t) => t.nav.setCurrentScreen('network-status') },
  { id: 'space.new', labelKey: 'shortcuts.newSpace', group: 'actions', run: (t) => t.openDialog({ kind: 'create' }) },
  { id: 'space.join', labelKey: 'shortcuts.joinSpace', group: 'actions', run: (t) => t.openDialog({ kind: 'join' }) },
  { id: 'help.whatsNew', labelKey: 'shortcuts.whatsNew', group: 'system', run: (t) => t.openWhatsNew() },
  { id: 'help.feedback', labelKey: 'shortcuts.sendFeedback', group: 'system', run: (t) => t.openDialog({ kind: 'feedback' }) },
  { id: 'help.docs', labelKey: 'shortcuts.openDocs', group: 'system', run: () => { window.open(docsUrl({ page: 'hub' }), '_blank', 'noopener') } },
]

function toCommand(row: AppCommandRow, targets: AppCommandTargets): Command {
  const { when } = row
  return {
    id: row.id,
    labelKey: row.labelKey,
    group: row.group,
    hiddenInPalette: row.hiddenInPalette,
    when: when ? (ctx) => when(ctx, targets) : undefined,
    run: () => row.run(targets),
  }
}

// Every space is reachable by name in the palette. The first nine also carry their ⌘1-9 chord, but
// only as a label: the binding itself lives in the native Go-to-Space menu, because Chromium claims
// the digit chords before the renderer can see them.
function spaceOpenCommand(space: Space, index: number, nav: AppNavigation): Command {
  return {
    id: `space.open.${space.spaceId}`,
    labelKey: 'shortcuts.openSpace',
    labelParams: { name: space.name },
    group: 'navigation',
    accelerator: spaceDigitAccelerator(index),
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
  const targets: AppCommandTargets = { nav, canGoBack, openDialog, openPalette, openCheatsheet, openWhatsNew }
  useRegisterCommands(APP_COMMANDS.map((row) => toCommand(row, targets)), [])
  useRegisterCommands(spaces.map((space, i) => spaceOpenCommand(space, i, nav)), [spaces])
  useMouseBackButton(runCommand)
}
