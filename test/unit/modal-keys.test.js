// The dialog keyboard contract (src/renderer/components/primitives/modalKeys.ts).
//
// Enter used to be answered in six different places: the Modal primitive (Cmd/Ctrl+Enter only) and
// five modals that each bound their own field. Three of those forgot the modifier check, so
// ⌘Enter ran the field handler AND the modal's confirm in one dispatch — two spaces created, two
// joins attempted, two saves sent. This file is the single decision they were all replaced by.
import test from 'brittle'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { transformSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// TypeScript the Node runner can't import directly; it imports nothing but types.
function loadModule (relPath) {
  const src = readFileSync(join(root, relPath), 'utf8')
  const { code } = transformSync(src, { loader: 'ts', format: 'cjs' })
  const mod = { exports: {} }
  new Function('module', 'exports', code)(mod, mod.exports)
  return mod.exports
}

const { modalKeyAction } = loadModule('src/renderer/components/primitives/modalKeys.ts')

function press (key, over = {}) {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    isComposing: false,
    targetTag: 'INPUT',
    targetRole: null,
    targetIsContentEditable: false,
    ...over,
  }
}

const MAC = { isDismissable: true, hasConfirm: true, isMac: true }
const WIN = { isDismissable: true, hasConfirm: true, isMac: false }

test('Escape dismisses a dismissable dialog, whatever else is true of it', (t) => {
  t.is(modalKeyAction(press('Escape'), MAC), 'dismiss')
  t.is(modalKeyAction(press('Escape'), { ...MAC, hasConfirm: false }), 'dismiss', 'a dialog with no confirm still closes')
  t.is(modalKeyAction(press('Escape', { targetTag: 'TEXTAREA' }), MAC), 'dismiss', 'including from inside a text box')
})

test('Escape is refused while the dialog holds a running operation', (t) => {
  t.is(modalKeyAction(press('Escape'), { ...MAC, isDismissable: false }), null)
})

test('plain Enter confirms from a field, and from the dialog panel itself', (t) => {
  t.is(modalKeyAction(press('Enter'), MAC), 'confirm')
  t.is(modalKeyAction(press('Enter', { targetTag: 'DIV', targetRole: 'dialog' }), MAC), 'confirm',
    'the panel is what holds focus when no field claims it')
  t.is(modalKeyAction(press('Enter', { targetTag: 'INPUT', targetRole: 'checkbox' }), MAC), null,
    'except where the control answers Enter itself')
})

test('plain Enter is left alone where the focused control owns it', (t) => {
  for (const tag of ['TEXTAREA', 'BUTTON', 'A', 'SELECT']) {
    t.is(modalKeyAction(press('Enter', { targetTag: tag }), MAC), null, `${tag} keeps its own Enter`)
  }
  t.is(modalKeyAction(press('Enter', { targetIsContentEditable: true }), MAC), null, 'contenteditable keeps its own Enter')
  t.is(modalKeyAction(press('Enter', { targetRole: 'combobox' }), MAC), null, 'the command palette keeps its own Enter')
  t.is(modalKeyAction(press('Enter', { targetTag: 'DIV', targetRole: 'menuitem' }), MAC), null)
})

test('Cmd/Ctrl+Enter confirms from anywhere, including a text box', (t) => {
  t.is(modalKeyAction(press('Enter', { metaKey: true, targetTag: 'TEXTAREA' }), MAC), 'confirm')
  t.is(modalKeyAction(press('Enter', { ctrlKey: true, targetTag: 'TEXTAREA' }), WIN), 'confirm')
  t.is(modalKeyAction(press('Enter', { metaKey: true, targetTag: 'BUTTON' }), MAC), 'confirm',
    'the chord beats the focused button')
})

test("the other platform's modifier is not a confirm", (t) => {
  t.is(modalKeyAction(press('Enter', { ctrlKey: true }), MAC), null, 'Ctrl+Enter on macOS')
  t.is(modalKeyAction(press('Enter', { metaKey: true }), WIN), null, 'Cmd+Enter on Windows/Linux')
})

test('Shift and Alt keep Enter out of the confirm path', (t) => {
  t.is(modalKeyAction(press('Enter', { shiftKey: true }), MAC), null, 'Shift+Enter is a newline')
  t.is(modalKeyAction(press('Enter', { altKey: true }), MAC), null)
})

test('a dialog with nothing to confirm never confirms', (t) => {
  // REGRESSION (FIX-MODAL-2: Enter used to activate the header ✕, so it silently cancelled the
  // destructive confirms.) Those dialogs pass no onConfirm; the answer here must be "nothing", and
  // the ✕ must no longer be what holds focus — see the frontend scenario for that half.
  const noConfirm = { ...MAC, hasConfirm: false }
  t.is(modalKeyAction(press('Enter'), noConfirm), null)
  t.is(modalKeyAction(press('Enter', { metaKey: true }), noConfirm), null)
})

test('an IME candidate commit is not a submit', (t) => {
  t.is(modalKeyAction(press('Enter', { isComposing: true }), MAC), null)
  t.is(modalKeyAction(press('Enter', { isComposing: true, metaKey: true }), MAC), null)
})

test('nothing else is a dialog gesture', (t) => {
  for (const key of ['a', ' ', 'Tab', 'ArrowDown', 'Backspace']) {
    t.is(modalKeyAction(press(key), MAC), null, `${JSON.stringify(key)} is not handled`)
  }
})

test('REGRESSION (FIX-MODAL-1: ⌘Enter in a modal text field submitted twice)', (t) => {
  // The field handlers are gone; one keypress now resolves to exactly one action, and the mod
  // variant resolves to the same one action rather than to a second, parallel path.
  const field = press('Enter', { targetTag: 'INPUT' })
  const withMod = press('Enter', { targetTag: 'INPUT', metaKey: true })
  t.is(modalKeyAction(field, MAC), 'confirm')
  t.is(modalKeyAction(withMod, MAC), 'confirm')
  t.is(modalKeyAction(field, MAC), modalKeyAction(withMod, MAC), 'one gesture, one confirm, one place')
})
