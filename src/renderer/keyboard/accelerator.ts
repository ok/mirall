// Accelerator spec parsing ('mod+shift+h') and KeyboardEvent matching, plus platform-aware display tokens (⌘⇧H vs Ctrl+Shift+H).
import type { CommandContext } from './registry.js'

export const isMacRuntime: boolean =
  typeof window !== 'undefined' && window.bridge?.getPlatform?.() === 'darwin'

export interface ParsedAccelerator {
  mod: boolean
  shift: boolean
  alt: boolean
  key: string
}

const MODIFIER_TOKENS = new Set(['mod', 'shift', 'alt', 'opt'])

export function parseAccelerator(spec: string): ParsedAccelerator {
  const parts = spec.toLowerCase().split('+')
  const mod = parts.includes('mod')
  const shift = parts.includes('shift')
  const alt = parts.includes('alt') || parts.includes('opt')
  const key = parts.filter((p) => !MODIFIER_TOKENS.has(p)).pop() ?? ''
  return { mod, shift, alt, key }
}

export function matchAccelerator(e: KeyboardEvent, spec: string): boolean {
  const a = parseAccelerator(spec)
  const modPressed = isMacRuntime ? e.metaKey : e.ctrlKey
  if (a.mod !== modPressed) return false
  if (a.shift !== e.shiftKey) return false
  if (a.alt !== e.altKey) return false
  if (a.key.startsWith('digit')) return e.code.toLowerCase() === a.key
  if (a.key === 'escape') return e.key === 'Escape'
  if (a.key === 'enter') return e.key === 'Enter'
  return e.key.toLowerCase() === a.key
}

// Returns the individual display tokens of an accelerator, e.g.
// ['⌘', '⇧', 'H'] on mac or ['Ctrl', 'Shift', 'H'] elsewhere. Rendering them as
// separate elements lets the UI control the inter-symbol gap precisely — a
// joined string is at the mercy of the font's space width (very wide in the
// monospace face the shortcut labels use). See AcceleratorLabel.
export function acceleratorParts(spec: string): string[] {
  const a = parseAccelerator(spec)
  const parts: string[] = []
  if (a.mod) parts.push(isMacRuntime ? '⌘' : 'Ctrl')
  if (a.shift) parts.push(isMacRuntime ? '⇧' : 'Shift')
  if (a.alt) parts.push(isMacRuntime ? '⌥' : 'Alt')
  let keyLabel: string
  if (a.key.startsWith('digit')) keyLabel = a.key.replace('digit', '')
  else if (a.key === 'enter') keyLabel = isMacRuntime ? '⏎' : 'Enter'
  else if (a.key === 'escape') keyLabel = 'Esc'
  else if (a.key === ',') keyLabel = ','
  else if (a.key === '/') keyLabel = '/'
  else if (a.key === 'arrowleft') keyLabel = '←'
  else if (a.key === 'arrowright') keyLabel = '→'
  else if (a.key === 'arrowup') keyLabel = '↑'
  else if (a.key === 'arrowdown') keyLabel = '↓'
  else keyLabel = a.key.toUpperCase()
  parts.push(keyLabel)
  return parts
}

export function formatAccelerator(spec: string): string {
  const parts = acceleratorParts(spec)
  return isMacRuntime ? parts.join(' ') : parts.join('+')
}

export function shouldIgnore(e: KeyboardEvent, allowList: ReadonlyArray<string>): boolean {
  if (e.key === 'Escape') return false
  const target = e.target
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  const inEditable = tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable
  if (!inEditable) return false
  return !allowList.some((spec) => matchAccelerator(e, spec))
}

export function createCommandContext(args: {
  currentScreen: string
  selectedSpaceId: string | null
}): CommandContext {
  const target = document.activeElement
  const isInputFocused =
    target instanceof HTMLElement &&
    (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
  return { ...args, isInputFocused }
}

export function isMac(): boolean {
  return isMacRuntime
}
