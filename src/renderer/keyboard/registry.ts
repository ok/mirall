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
  when?: (ctx: CommandContext) => boolean
  run: (ctx: CommandContext) => void | Promise<void>
}

export const GLOBAL_HOTKEYS = ['mod+k', 'mod+,', 'mod+/'] as const
