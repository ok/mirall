// Command model for the keyboard layer: Command/CommandContext types, how the palette ranks a command
// against a query, and the global hotkeys that stay active inside text inputs.
import type { Screen } from '../shell/navigation.js'

export type CommandGroup = 'navigation' | 'actions' | 'space' | 'system'

export interface CommandContext {
  currentScreen: Screen
  selectedSpaceId: string | null
  isInputFocused: boolean
}

export interface Command {
  id: string
  labelKey: string
  labelParams?: Record<string, string | number>
  keywordsKey?: string
  group: CommandGroup
  accelerator?: string
  hiddenInPalette?: boolean
  when?: (ctx: CommandContext) => boolean
  run: (ctx: CommandContext) => void | Promise<void>
}

export const GLOBAL_HOTKEYS = ['mod+k', 'mod+,', 'mod+/', 'mod+f'] as const

// A folder view is still inside its space, so space-scoped commands stay available there;
// the ones that need SpaceScreen's modals raise a pending action, which navigates back there first.
export function isInSpace(ctx: CommandContext): boolean {
  return ctx.currentScreen === 'space-view' || ctx.currentScreen === 'folder-view'
}

// A command's search words rank below any match on its label, so a query that names a command
// outright puts that command first.
export function paletteRank(label: string, keywords: string, query: string): number {
  const q = query.trim().toLowerCase()
  if (!q) return 1
  const name = label.toLowerCase()
  if (name === q) return 200
  if (name.startsWith(q)) return 100
  if (name.includes(' ' + q)) return 50
  if (name.includes(q)) return 25
  return keywords.toLowerCase().includes(q) ? 10 : 0
}
