// The accelerator catalogue: the single source of truth for every key chord in the app.
// Call sites never spell an accelerator out — useRegisterCommand looks it up by id — so a
// chord that is not listed here does not exist at runtime and cannot be missing from the
// cheatsheet. test/unit/keyboard-catalog.test.js enforces both directions.
import type { CommandGroup } from './registry.js'

export interface KnownCommand {
  id: string
  labelKey: string
  group: CommandGroup
  accelerator: string
  acceleratorRangeEnd?: string
  // Bound at runtime across a family of generated ids rather than to this one id.
  dynamic?: boolean
}

const isMacRuntime: boolean =
  typeof window !== 'undefined' && window.bridge?.getPlatform?.() === 'darwin'

// Home uses a platform-specific chord: ⌘⇧H on macOS (Cmd+H is the system Hide
// shortcut), Ctrl+H on Windows/Linux. ('mod' = Cmd on mac / Ctrl elsewhere.)
const HOME_ACCELERATOR = isMacRuntime ? 'mod+shift+h' : 'mod+h'

const SPACE_DIGIT_COUNT = 9

export const KEYBOARD_SHORTCUTS: ReadonlyArray<KnownCommand> = [
  { id: 'palette.open',     labelKey: 'shortcuts.openPalette',     group: 'system',     accelerator: 'mod+k' },
  { id: 'shortcuts.show',   labelKey: 'shortcuts.showShortcuts',   group: 'system',     accelerator: 'mod+/' },
  { id: 'nav.back',         labelKey: 'shortcuts.back',            group: 'navigation', accelerator: 'mod+arrowleft' },
  { id: 'nav.home',         labelKey: 'shortcuts.home',            group: 'navigation', accelerator: HOME_ACCELERATOR },
  { id: 'space.openNth',    labelKey: 'shortcuts.openNthSpace',    group: 'navigation', accelerator: 'mod+digit1', acceleratorRangeEnd: 'mod+digit9', dynamic: true },
  { id: 'settings.open',    labelKey: 'shortcuts.openSettings',    group: 'navigation', accelerator: 'mod+,' },
  { id: 'profile.open',     labelKey: 'shortcuts.openProfile',     group: 'navigation', accelerator: 'mod+shift+p' },
  { id: 'activity.open',    labelKey: 'shortcuts.openActivityLog', group: 'navigation', accelerator: 'mod+shift+l' },
  { id: 'space.new',        labelKey: 'shortcuts.newSpace',        group: 'actions',    accelerator: 'mod+n' },
  { id: 'space.join',       labelKey: 'shortcuts.joinSpace',       group: 'actions',    accelerator: 'mod+j' },
  { id: 'search.focus',     labelKey: 'shortcuts.focusSearch',     group: 'actions',    accelerator: 'mod+f' },
  { id: 'space.addFiles',   labelKey: 'shortcuts.addFiles',        group: 'space',      accelerator: 'mod+u' },
  { id: 'space.addFolder',  labelKey: 'shortcuts.addFolder',       group: 'space',      accelerator: 'mod+shift+u' },
]

const ACCELERATOR_BY_ID = new Map<string, string>(
  KEYBOARD_SHORTCUTS.filter((c) => !c.dynamic).map((c) => [c.id, c.accelerator]),
)

export function acceleratorFor(id: string): string | undefined {
  return ACCELERATOR_BY_ID.get(id)
}

export function spaceDigitAccelerator(index: number): string | undefined {
  return index < SPACE_DIGIT_COUNT ? `mod+digit${index + 1}` : undefined
}
