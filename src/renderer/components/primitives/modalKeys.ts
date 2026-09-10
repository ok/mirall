// The dialog keyboard contract, as a pure decision so it can be tested without a DOM. Enter belongs
// to the dialog, not to its fields:
//
//   Escape                 dismiss, when the dialog is dismissable
//   Cmd/Ctrl+Enter         confirm, always — the escape hatch for a textarea
//   Enter                  confirm, unless the focused control owns Enter itself
//
// "Owns Enter itself" is a textarea (newline), a button or link (its own activation, which would
// otherwise fire alongside the confirm), a select, or anything editable.

export type ModalKeyAction = 'confirm' | 'dismiss' | null

export interface ModalKeyEvent {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  // Mid-composition Enter commits the IME candidate; it is not a submit.
  isComposing: boolean
  targetTag: string
  targetRole: string | null
  targetIsContentEditable: boolean
}

export interface ModalKeyState {
  isDismissable: boolean
  hasConfirm: boolean
  isMac: boolean
}

const TAGS_OWNING_ENTER = new Set(['TEXTAREA', 'BUTTON', 'A', 'SELECT'])

// Roles whose own Enter handling would run alongside ours. `combobox`/`textbox` are here because a
// widget that declares them (the command palette) has already bound Enter to its own selection.
const ROLES_OWNING_ENTER = new Set([
  'button',
  'link',
  'checkbox',
  'switch',
  'radio',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'tab',
  'combobox',
  'textbox',
])

function ownsEnter(e: ModalKeyEvent): boolean {
  if (e.targetIsContentEditable) return true
  if (TAGS_OWNING_ENTER.has(e.targetTag)) return true
  return e.targetRole !== null && ROLES_OWNING_ENTER.has(e.targetRole)
}

export function modalKeyAction(e: ModalKeyEvent, s: ModalKeyState): ModalKeyAction {
  if (e.key === 'Escape') return s.isDismissable ? 'dismiss' : null
  if (e.key !== 'Enter') return null
  if (!s.hasConfirm || e.isComposing) return null

  const mod = s.isMac ? e.metaKey : e.ctrlKey
  if (mod) return 'confirm'

  // Any other modifier means something else: Shift+Enter is a newline, and the platform's *other*
  // modifier is not this app's confirm chord on this platform.
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return null

  return ownsEnter(e) ? null : 'confirm'
}

// Bridges a React (or DOM) keyboard event into the shape above.
export function describeModalKeyEvent(e: {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  target: EventTarget | null
  nativeEvent?: { isComposing?: boolean }
}): ModalKeyEvent {
  const target = e.target instanceof HTMLElement ? e.target : null
  return {
    key: e.key,
    metaKey: e.metaKey,
    ctrlKey: e.ctrlKey,
    shiftKey: e.shiftKey,
    altKey: e.altKey,
    isComposing: e.nativeEvent?.isComposing === true,
    targetTag: target?.tagName ?? '',
    targetRole: target?.getAttribute('role') ?? null,
    targetIsContentEditable: target?.isContentEditable === true,
  }
}
