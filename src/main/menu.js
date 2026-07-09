// Native application menu template — a pure function of platform + UI context
// (inSpace gates the space-scoped items) so it is testable without Electron.
// Menu items don't act directly: their handlers dispatch keyboard-command ids
// that main forwards to the renderer (see sendKeyboardCommand in main.js).
function buildAppMenuTemplate({ platform, isDev, inSpace, appName, handlers }) {
  const isMac = platform === 'darwin'
  const template = []

  if (isMac) {
    template.push({
      label: appName,
      submenu: [
        { label: `About ${appName}`, click: handlers.openAbout },
        { type: 'separator' },
        { label: 'Preferences…', accelerator: 'Cmd+,', click: handlers.openSettings },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    })
  }

  const fileSubmenu = [
    { label: 'New Space', accelerator: 'CmdOrCtrl+N', click: handlers.newSpace },
    { label: 'Join Space', accelerator: 'CmdOrCtrl+J', click: handlers.joinSpace },
    { type: 'separator' },
    { label: 'Add Files…', accelerator: 'CmdOrCtrl+U', enabled: inSpace, click: handlers.addFiles },
    { label: 'Add Folder…', accelerator: 'CmdOrCtrl+Shift+U', enabled: inSpace, click: handlers.addFolder },
    { label: 'Invite People…', enabled: inSpace, click: handlers.invite },
  ]
  if (!isMac) {
    fileSubmenu.push(
      { type: 'separator' },
      { label: 'Preferences…', accelerator: 'CmdOrCtrl+,', click: handlers.openSettings },
    )
  }
  fileSubmenu.push(
    { type: 'separator' },
    isMac
      ? { role: 'close' }
      : { role: 'quit', label: `Quit ${appName}`, accelerator: 'CmdOrCtrl+Q' },
  )
  template.push({ label: 'File', submenu: fileSubmenu })

  template.push({ role: 'editMenu' })

  const viewSubmenu = [
    { label: 'Back', accelerator: 'CmdOrCtrl+Left', click: handlers.navBack },
    { label: 'Home', accelerator: isMac ? 'Cmd+Shift+H' : 'Ctrl+H', click: handlers.navHome },
    { type: 'separator' },
    { label: 'Command Palette', accelerator: 'CmdOrCtrl+K', click: handlers.openPalette },
    { label: 'Keyboard Shortcuts', accelerator: 'CmdOrCtrl+/', click: handlers.showShortcuts },
    { type: 'separator' },
    { role: 'zoomIn' },
    { role: 'zoomOut' },
    { role: 'resetZoom' },
    { type: 'separator' },
    { role: 'togglefullscreen' },
    { type: 'separator' },
    { role: 'toggleDevTools' },
  ]
  if (isDev) {
    viewSubmenu.push(
      { role: 'reload' },
      { role: 'forceReload' },
    )
  }
  template.push({ label: 'View', submenu: viewSubmenu })

  if (isMac) template.push({ role: 'windowMenu' })

  const helpSubmenu = [
    { label: "What's New…", click: handlers.whatsNew },
    { label: 'Documentation', click: handlers.openDocs },
    { type: 'separator' },
    { label: 'Send Feedback…', click: handlers.sendFeedback },
  ]
  if (!isMac) {
    helpSubmenu.push(
      { type: 'separator' },
      { label: `About ${appName}`, click: handlers.openAbout },
    )
  }
  template.push({ role: 'help', label: 'Help', submenu: helpSubmenu })

  return template
}

module.exports = { buildAppMenuTemplate }
