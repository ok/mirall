import test from 'brittle'
import { matchWindowShortcut } from '../../src/main/window-shortcuts.js'

const down = (o) => ({ type: 'keyDown', ...o })

test('F12 toggles devtools on every platform', (t) => {
  t.alike(matchWindowShortcut(down({ key: 'F12' }), { isMac: false }), { kind: 'devtools' })
  t.alike(matchWindowShortcut(down({ key: 'F12' }), { isMac: true }), { kind: 'devtools' })
})

test('Ctrl+Shift+I is devtools on Win/Linux; Cmd+Alt+I on mac', (t) => {
  t.alike(matchWindowShortcut(down({ key: 'I', control: true, shift: true }), { isMac: false }), { kind: 'devtools' })
  t.alike(matchWindowShortcut(down({ key: 'i', meta: true, alt: true }), { isMac: true }), { kind: 'devtools' })
})

test('zoom in/out/reset via the platform accelerator', (t) => {
  t.alike(matchWindowShortcut(down({ key: '=', control: true }), { isMac: false }), { kind: 'zoom', direction: 'in' })
  t.alike(matchWindowShortcut(down({ key: '+', control: true }), { isMac: false }), { kind: 'zoom', direction: 'in' })
  t.alike(matchWindowShortcut(down({ key: '-', meta: true }), { isMac: true }), { kind: 'zoom', direction: 'out' })
  t.alike(matchWindowShortcut(down({ key: '_', meta: true }), { isMac: true }), { kind: 'zoom', direction: 'out' })
  t.alike(matchWindowShortcut(down({ key: '0', meta: true }), { isMac: true }), { kind: 'zoom', direction: 'reset' })
})

test('the wrong accelerator (Ctrl on mac, Cmd on win) does not zoom', (t) => {
  t.is(matchWindowShortcut(down({ key: '=', control: true }), { isMac: true }), null)
  t.is(matchWindowShortcut(down({ key: '=', meta: true }), { isMac: false }), null)
})

test('non-keyDown and unmodified keys are ignored', (t) => {
  t.is(matchWindowShortcut({ type: 'keyUp', key: 'F12' }, { isMac: false }), null)
  t.is(matchWindowShortcut(down({ key: 'a' }), { isMac: false }), null)
  t.is(matchWindowShortcut(down({ key: '0' }), { isMac: false }), null)
})
