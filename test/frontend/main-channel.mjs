import { readFileSync } from 'node:fs'

// Background mode reaches each instance's main process over the Node inspector (`--inspect=0`), for
// the input the accessibility API cannot deliver to a window that is not frontmost: key presses,
// pointer moves and the native file pickers. Everything else stays on agent-desktop.

export function inspectorUrl(logText) {
  return /Debugger listening on (ws:\/\/\S+)/.exec(logText)?.[1] ?? null
}

const KEY_NAMES = {
  escape: 'Escape',
  esc: 'Escape',
  return: 'Return',
  enter: 'Return',
  tab: 'Tab',
  space: 'Space',
  backspace: 'Backspace',
  delete: 'Delete',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  ',': ',',
  '/': '/',
  '+': 'Plus',
  plus: 'Plus',
  '-': '-',
  '0': '0',
}

const MODIFIERS = { cmd: 'meta', command: 'meta', meta: 'meta', ctrl: 'control', control: 'control', alt: 'alt', option: 'alt', shift: 'shift' }

// 'cmd+shift+u' → { key: 'U', modifiers: ['meta', 'shift'] }, in Electron's input-event vocabulary.
export function parseCombo(combo) {
  const parts = combo.toLowerCase().split('+')
  // A trailing '+' is the Plus key itself ('cmd++').
  if (parts.at(-1) === '' && parts.length > 1) parts.splice(-2, 2, '+')
  const keyPart = parts.pop()
  const modifiers = parts.map((m) => {
    const mod = MODIFIERS[m]
    if (!mod) throw new Error(`unknown modifier "${m}" in "${combo}"`)
    return mod
  })
  const key = KEY_NAMES[keyPart] ?? (keyPart.length === 1 ? keyPart.toUpperCase() : null)
  if (!key) throw new Error(`unknown key "${keyPart}" in "${combo}"`)
  return { key, modifiers: [...new Set(modifiers)].sort() }
}

// True when an Electron menu accelerator ('CmdOrCtrl+Shift+U') is the same chord as a parsed combo.
// macOS resolves CmdOrCtrl to Cmd, which is the only platform the harness runs on.
export function acceleratorMatches(accelerator, { key, modifiers }) {
  if (!accelerator || modifiers.length === 0) return false
  const parsed = parseCombo(accelerator.replace(/CommandOrControl|CmdOrCtrl/gi, 'cmd'))
  return parsed.key === key && parsed.modifiers.join() === modifiers.join()
}

// Keys whose press also types a character: Chromium activates a focused button from that char
// (keypress) event, not from keyDown.
const KEY_CHARS = { Return: '\r', Space: ' ' }

// The sendInputEvent sequence one key press produces: keyDown, a char event when the key types a
// character (no command modifier), then keyUp.
export function keyEvents({ key, modifiers }) {
  const events = [{ type: 'keyDown', keyCode: key, modifiers }]
  const commanded = modifiers.some((m) => m === 'meta' || m === 'control')
  const char = KEY_CHARS[key] ?? (key.length === 1 ? key : null)
  if (char && !commanded) {
    const typed = modifiers.includes('shift') ? char.toUpperCase() : char.toLowerCase()
    events.push({ type: 'char', keyCode: typed, modifiers })
  }
  events.push({ type: 'keyUp', keyCode: key, modifiers })
  return events
}

// Runs inside the instance's main process (serialised with toString, so it closes over nothing).
// The app window is the one that loaded the app:// bundle; the others are internal helpers.
// Pickers never open natively: a folder pick (`dialog.showOpenDialog`) and a file pick (the page's
// `<input type=file>`, intercepted over CDP) both wait for the path the harness queues with
// armPick, in whichever order the two arrive.
function installHooks() {
  const { BrowserWindow, Menu, dialog } = process.mainModule.require('electron')
  const appWindow = () => BrowserWindow.getAllWindows()
    .find((w) => !w.isDestroyed() && w.webContents.getURL().startsWith('app://'))
  const menuItems = () => {
    const walk = (items) => items.flatMap((i) => [i, ...(i.submenu ? walk(i.submenu.items) : [])])
    return walk(Menu.getApplicationMenu()?.items ?? [])
  }
  const fe = {
    picks: 0,
    opened: 0,
    pickError: null,
    queued: null,
    waiting: null,
  }
  const openPicker = (fulfil) => {
    fe.opened++
    if (fe.queued === null) {
      fe.waiting = fulfil
      return
    }
    const absPath = fe.queued
    fe.queued = null
    fulfil(absPath)
  }
  dialog.showOpenDialog = () => new Promise((resolve) => openPicker((absPath) => {
    fe.picks++
    resolve({ canceled: false, filePaths: [absPath] })
  }))
  const attach = (wc) => {
    if (wc.debugger.isAttached()) return wc.debugger
    wc.debugger.attach('1.3')
    wc.debugger.on('message', (_e, method, params) => {
      if (method !== 'Page.fileChooserOpened') return
      openPicker((absPath) => {
        wc.debugger.sendCommand('DOM.setFileInputFiles', { files: [absPath], backendNodeId: params.backendNodeId })
          .then(() => { fe.picks++ }, (err) => { fe.pickError = err.message })
      })
    })
    return wc.debugger
  }
  Object.assign(fe, {
    async focusEmulation() {
      const win = appWindow()
      if (!win) return false
      const dbg = attach(win.webContents)
      await dbg.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
      await dbg.sendCommand('Page.enable')
      await dbg.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true })
      if (!win.webContents.listenerCount('did-finish-load')) {
        win.webContents.on('did-finish-load', () => { fe.focusEmulation() })
      }
      return true
    },
    accelerators() {
      return menuItems().map((i) => i.accelerator).filter(Boolean)
    },
    // A real key equivalent is a user gesture, and pages gate things on one (a file chooser opens
    // only within a few seconds of it). Grant the page that activation before the item fires.
    async clickMenu(accelerator) {
      const item = menuItems().find((i) => i.accelerator === accelerator)
      if (!item || !item.enabled || !item.visible) return 'disabled'
      const win = appWindow()
      await win?.webContents.executeJavaScript('0', true)
      item.click(undefined, win, win?.webContents)
      return 'menu'
    },
    // sendInputEvent only queues the events. Resolve after the page has rendered a frame past them,
    // so the handler's state change has landed before the harness's next step — a press that
    // closes a modal must not race the command that follows it.
    async sendInput(events) {
      const win = appWindow()
      if (!win) return 'no-window'
      for (const ev of events) win.webContents.sendInputEvent(ev)
      await win.webContents.executeJavaScript(
        'new Promise((r) => { requestAnimationFrame(() => r(0)); setTimeout(() => r(0), 500) })',
      )
      return 'keys'
    },
    contentOrigin() {
      const b = appWindow()?.getContentBounds()
      return b ? { x: b.x, y: b.y } : null
    },
    armPick(absPath) {
      if (fe.waiting) {
        const fulfil = fe.waiting
        fe.waiting = null
        fulfil(absPath)
        return
      }
      fe.queued = absPath
    },
    disarmPick() {
      fe.queued = null
    },
  })
  globalThis.__fe = fe
  return true
}

export class MainChannel {
  constructor(ws) {
    this.ws = ws
    this.nextId = 0
    this.pending = new Map()
    ws.addEventListener('message', (m) => {
      const msg = JSON.parse(m.data)
      const done = this.pending.get(msg.id)
      if (!done) return
      this.pending.delete(msg.id)
      done(msg)
    })
    ws.addEventListener('close', () => {
      for (const done of this.pending.values()) done({ error: { message: 'inspector connection closed' } })
      this.pending.clear()
    })
  }

  // Wait for the instance to print its inspector URL, connect, and install the hooks.
  static async open(logPath, timeout = 30000) {
    const deadline = Date.now() + timeout
    let url = null
    while (!url) {
      try { url = inspectorUrl(readFileSync(logPath, 'utf8')) } catch {}
      if (url) break
      if (Date.now() > deadline) throw new Error(`no inspector URL in ${logPath} after ${timeout}ms`)
      await new Promise((r) => setTimeout(r, 100))
    }
    const ws = new WebSocket(url)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', () => reject(new Error(`inspector connect failed: ${url}`)), { once: true })
    })
    const channel = new MainChannel(ws)
    await channel.eval(`(${installHooks.toString()})()`)
    return channel
  }

  eval(expression) {
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      this.pending.set(id, (msg) => {
        if (msg.error) return reject(new Error(`inspector: ${msg.error.message}`))
        const { result, exceptionDetails } = msg.result
        if (exceptionDetails) return reject(new Error(`main: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`))
        resolve(result.value)
      })
      this.ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
    })
  }

  focusEmulation() {
    return this.eval('globalThis.__fe.focusEmulation()')
  }

  // A chord that is a menu accelerator clicks that menu item, like macOS does before the page sees
  // the key; anything else goes to the page as key events. 'disabled' is a menu item that exists but
  // is disabled, which the caller treats like a lost trigger.
  async press(combo) {
    const parsed = parseCombo(combo)
    const accelerators = await this.eval('globalThis.__fe.accelerators()')
    const accelerator = accelerators.find((a) => {
      try { return acceleratorMatches(a, parsed) } catch { return false }
    })
    if (accelerator) return this.eval(`globalThis.__fe.clickMenu(${JSON.stringify(accelerator)})`)
    return this.eval(`globalThis.__fe.sendInput(${JSON.stringify(keyEvents(parsed))})`)
  }

  // Pointer events at a screen point (the AX bounds space), translated into the window's content.
  async mouse(screenX, screenY, types) {
    const origin = await this.eval('globalThis.__fe.contentOrigin()')
    if (!origin) throw new Error('no app window for pointer input')
    const x = Math.round(screenX - origin.x)
    const y = Math.round(screenY - origin.y)
    const events = types.map((type) => ({ type, x, y, button: 'left', clickCount: 1 }))
    return this.eval(`globalThis.__fe.sendInput(${JSON.stringify(events)})`)
  }

  // Move the synthetic pointer to the content's top-left corner, off every element, so the element
  // it was over gets its mouseleave.
  park() {
    return this.eval(`globalThis.__fe.sendInput(${JSON.stringify([{ type: 'mouseMove', x: 1, y: 1 }])})`)
  }

  armPick(absPath) {
    return this.eval(`globalThis.__fe.armPick(${JSON.stringify(absPath)})`)
  }

  disarmPick() {
    return this.eval('globalThis.__fe.disarmPick()')
  }

  pickState() {
    return this.eval('({ picks: globalThis.__fe.picks, opened: globalThis.__fe.opened, error: globalThis.__fe.pickError })')
  }

  close() {
    try { this.ws.close() } catch {}
  }
}
