// Command model for the keyboard layer: Command/CommandContext types and the global hotkeys that stay active inside text inputs.
export type CommandGroup = 'navigation' | 'actions' | 'space' | 'system'

export interface CommandContext {
  currentScreen: string
  selectedSpaceId: string | null
  isInputFocused: boolean
}

export interface Command {
  id: string
  labelKey: string
  labelParams?: Record<string, string | number>
  group: CommandGroup
  accelerator?: string
  hiddenInPalette?: boolean
  when?: (ctx: CommandContext) => boolean
  run: (ctx: CommandContext) => void | Promise<void>
}

export const GLOBAL_HOTKEYS = ['mod+k', 'mod+,', 'mod+/', 'mod+f'] as const

// A folder view is still inside its space, so space-scoped commands stay available there;
// the ones that need SpaceView's modals route through dispatchSpaceAction to get back first.
export function isInSpace(ctx: CommandContext): boolean {
  return ctx.currentScreen === 'space-view' || ctx.currentScreen === 'folder-view'
}
