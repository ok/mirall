// Static shortcut catalog for the cheatsheet; the live commands register at runtime through KeyboardProvider.
import type { CommandGroup } from './registry.js'

export interface KnownCommand {
  id: string
  labelKey: string
  group: CommandGroup
  accelerator: string
}

const isMacRuntime: boolean =
  typeof window !== 'undefined' && window.bridge?.getPlatform?.() === 'darwin'

// Home uses a platform-specific chord: ⌘⇧H on macOS (Cmd+H is the system Hide
// shortcut), Ctrl+H on Windows/Linux. ('mod' = Cmd on mac / Ctrl elsewhere.)
export const HOME_ACCELERATOR = isMacRuntime ? 'mod+shift+h' : 'mod+h'

export const KEYBOARD_SHORTCUTS: ReadonlyArray<KnownCommand> = [
  { id: 'palette.open',     labelKey: 'shortcuts.openPalette',    group: 'system',     accelerator: 'mod+k' },
  { id: 'shortcuts.show',   labelKey: 'shortcuts.showShortcuts',  group: 'system',     accelerator: 'mod+/' },
  { id: 'nav.back',         labelKey: 'shortcuts.back',           group: 'navigation', accelerator: 'mod+arrowleft' },
  { id: 'nav.home',         labelKey: 'shortcuts.home',           group: 'navigation', accelerator: HOME_ACCELERATOR },
  { id: 'settings.open',    labelKey: 'shortcuts.openSettings',   group: 'navigation', accelerator: 'mod+,' },
  { id: 'space.new',        labelKey: 'shortcuts.newSpace',       group: 'actions',    accelerator: 'mod+n' },
  { id: 'space.join',       labelKey: 'shortcuts.joinSpace',      group: 'actions',    accelerator: 'mod+j' },
  { id: 'space.addFiles',   labelKey: 'shortcuts.addFiles',       group: 'space',      accelerator: 'mod+u' },
  { id: 'space.addFolder',  labelKey: 'shortcuts.addFolder',      group: 'space',      accelerator: 'mod+shift+u' },
]
