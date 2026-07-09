// Minimal Electron host: load the layout harness in a fixed-size, hidden window
// (background throttling disabled so timers/rAF run at full speed while hidden),
// poll until the harness publishes window.__results, print them as a sentinel
// line, and exit. Real Chromium => real layout => trustworthy scrollHeight.
const { app, BrowserWindow } = require('electron')
const path = require('node:path')

const CONTENT_WIDTH = Number(process.env.HARNESS_W || 1280)
const CONTENT_HEIGHT = Number(process.env.HARNESS_H || 800)
const HARNESS_HTML = process.env.HARNESS_HTML || 'harness.html'

app.disableHardwareAcceleration()
if (app.dock) app.dock.hide()

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: CONTENT_WIDTH,
    height: CONTENT_HEIGHT,
    useContentSize: true,
    show: false,
    frame: false,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  let done = false
  const fail = (msg) => {
    if (done) return
    done = true
    process.stdout.write('__HARNESS__' + JSON.stringify({ error: msg }) + '__END__\n')
    setTimeout(() => { app.exit(1) }, 50)
  }

  win.webContents.on('console-message', (_e, _level, message) => {
    process.stderr.write('[renderer] ' + message + '\n')
  })
  win.webContents.on('render-process-gone', (_e, d) => fail('render-process-gone: ' + JSON.stringify(d)))

  await win.loadFile(path.join(__dirname, HARNESS_HTML))

  const deadline = Date.now() + 30000
  /* eslint-disable no-await-in-loop */
  while (Date.now() < deadline && !done) {
    let res = null
    try {
      res = await win.webContents.executeJavaScript('window.__results || null')
    } catch (e) {
      // page may be mid-navigation; retry
    }
    if (res) {
      done = true
      process.stdout.write('__HARNESS__' + JSON.stringify(res) + '__END__\n')
      setTimeout(() => { app.exit(0) }, 50)
      return
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  if (!done) fail('timed out waiting for window.__results')
})

app.on('window-all-closed', () => app.quit())
