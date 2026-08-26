import test from 'brittle'
import { buildAppMenuTemplate } from '../../src/main/menu.js'

const noop = () => {}
const allHandlers = {
  openAbout: noop,
  openSettings: noop,
  newSpace: noop,
  joinSpace: noop,
  addFiles: noop,
  addFolder: noop,
  invite: noop,
  navBack: noop,
  navHome: noop,
  openProfile: noop,
  openActivityLog: noop,
  openSpace: noop,
  openPalette: noop,
  showShortcuts: noop,
  whatsNew: noop,
  sendFeedback: noop,
  openDocs: noop,
}

const baseOpts = { isDev: false, inSpace: false, appName: 'Mirall', handlers: allHandlers }

function topLabels(template) {
  return template.map((t) => t.label || t.role)
}

function topRoles(template) {
  return template.map((t) => t.role || null)
}

function find(template, label) {
  return template.find((t) => t.label === label || t.role === label)
}

function findInSubmenu(submenu, label) {
  return submenu.find((t) => t.label === label || t.role === label)
}

test('darwin: app submenu, windowMenu, services/hide present', (t) => {
  const tpl = buildAppMenuTemplate({ ...baseOpts, platform: 'darwin' })
  const labels = topLabels(tpl)
  const roles = topRoles(tpl)
  t.is(labels[0], 'Mirall', 'first submenu is app menu')
  t.ok(labels.includes('File'), 'File present')
  t.ok(roles.includes('editMenu'), 'Edit role present')
  t.ok(labels.includes('View'), 'View present')
  t.ok(roles.includes('windowMenu'), 'Window role present on mac')
  t.ok(roles.includes('help'), 'Help role present')

  const appMenu = find(tpl, 'Mirall').submenu
  t.ok(findInSubmenu(appMenu, 'services'), 'services in app menu')
  t.ok(findInSubmenu(appMenu, 'hide'), 'hide in app menu')
  t.ok(findInSubmenu(appMenu, 'hideOthers'), 'hideOthers in app menu')
  t.ok(findInSubmenu(appMenu, 'unhide'), 'unhide in app menu')
  t.ok(findInSubmenu(appMenu, 'About Mirall'), 'About item in app menu')

  const help = find(tpl, 'help').submenu
  t.absent(findInSubmenu(help, 'About Mirall'), 'no About in Help on mac (it lives in app menu)')
})

test('win32 / linux: no mac-only roles, About in Help', (t) => {
  for (const platform of ['win32', 'linux']) {
    const tpl = buildAppMenuTemplate({ ...baseOpts, platform })
    const labels = topLabels(tpl)
    const roles = topRoles(tpl)
    t.absent(labels.includes('Mirall'), `${platform}: no app submenu`)
    t.absent(roles.includes('windowMenu'), `${platform}: no windowMenu role`)
    t.ok(labels.includes('File'), `${platform}: File present`)
    t.ok(roles.includes('editMenu'), `${platform}: Edit role present`)
    t.ok(labels.includes('View'), `${platform}: View present`)
    t.ok(roles.includes('help'), `${platform}: Help present`)

    const file = find(tpl, 'File').submenu
    t.ok(findInSubmenu(file, 'Preferences…'), `${platform}: Preferences moves to File menu`)

    const help = find(tpl, 'help').submenu
    t.ok(findInSubmenu(help, 'About Mirall'), `${platform}: About present in Help`)
  }
})

test('Help submenu always carries the cross-platform items', (t) => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const tpl = buildAppMenuTemplate({ ...baseOpts, platform })
    const help = find(tpl, 'help').submenu
    t.ok(findInSubmenu(help, "What's New…"), `${platform}: What's New present`)
    t.ok(findInSubmenu(help, 'Documentation'), `${platform}: Documentation present`)
    t.ok(findInSubmenu(help, 'Send Feedback…'), `${platform}: Send Feedback present`)
  }
})

test('Help submenu does NOT carry reveal-folder or check-for-updates items', (t) => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const tpl = buildAppMenuTemplate({ ...baseOpts, platform })
    const help = find(tpl, 'help').submenu
    t.absent(findInSubmenu(help, 'Reveal Downloads Folder'), `${platform}: no Reveal Downloads`)
    t.absent(findInSubmenu(help, 'Reveal Storage Folder'), `${platform}: no Reveal Storage`)
    t.absent(findInSubmenu(help, 'Check for Updates…'), `${platform}: no Check for Updates in Help`)
  }
  const mac = buildAppMenuTemplate({ ...baseOpts, platform: 'darwin' })
  const appMenu = find(mac, 'Mirall').submenu
  t.absent(findInSubmenu(appMenu, 'Check for Updates…'), 'no Check for Updates in mac app menu either')
})

test('Reload / Force Reload visible only in dev; DevTools always visible', (t) => {
  const prod = buildAppMenuTemplate({ ...baseOpts, platform: 'darwin', isDev: false })
  const prodView = find(prod, 'View').submenu
  t.absent(findInSubmenu(prodView, 'reload'), 'no Reload in prod')
  t.absent(findInSubmenu(prodView, 'forceReload'), 'no Force Reload in prod')
  t.ok(findInSubmenu(prodView, 'toggleDevTools'), 'DevTools in prod')

  const dev = buildAppMenuTemplate({ ...baseOpts, platform: 'darwin', isDev: true })
  const devView = find(dev, 'View').submenu
  t.ok(findInSubmenu(devView, 'reload'), 'Reload in dev')
  t.ok(findInSubmenu(devView, 'forceReload'), 'Force Reload in dev')
  t.ok(findInSubmenu(devView, 'toggleDevTools'), 'DevTools in dev')
})

test('View submenu has zoom roles', (t) => {
  const tpl = buildAppMenuTemplate({ ...baseOpts, platform: 'darwin' })
  const view = find(tpl, 'View').submenu
  t.ok(findInSubmenu(view, 'zoomIn'), 'zoomIn role present')
  t.ok(findInSubmenu(view, 'zoomOut'), 'zoomOut role present')
  t.ok(findInSubmenu(view, 'resetZoom'), 'resetZoom role present')
  t.ok(findInSubmenu(view, 'togglefullscreen'), 'togglefullscreen role present')
  t.ok(findInSubmenu(view, 'Back'), 'Back item present')
  t.ok(findInSubmenu(view, 'Home'), 'Home item present')
})

test('View submenu exposes Profile and Activity Log with their chords', (t) => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const view = find(buildAppMenuTemplate({ ...baseOpts, platform }), 'View').submenu
    const profile = findInSubmenu(view, 'Profile')
    const activity = findInSubmenu(view, 'Activity Log')
    t.ok(profile, `${platform}: Profile item present`)
    t.ok(activity, `${platform}: Activity Log item present`)
    t.is(profile.accelerator, 'CmdOrCtrl+Shift+P', `${platform}: Profile bound to mod+shift+P`)
    t.is(activity.accelerator, 'CmdOrCtrl+Shift+L', `${platform}: Activity Log bound to mod+shift+L`)
  }
})

test('the Activity Log Find chord stays out of the native menu', (t) => {
  // mod+F is scoped to the Activity Log, so a menu accelerator would claim it
  // app-wide and fire the command on screens that have nothing to search.
  const json = JSON.stringify(buildAppMenuTemplate({ ...baseOpts, platform: 'darwin' }))
  t.absent(json.includes('CmdOrCtrl+F'), 'no global Find accelerator')
})

test('Go to Space lists the spaces it is given and binds them to mod+1..9', (t) => {
  const spaces = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, name: `Space ${i}` }))
  const view = find(buildAppMenuTemplate({ ...baseOpts, platform: 'darwin', spaces }), 'View').submenu
  const go = findInSubmenu(view, 'Go to Space')
  t.ok(go, 'Go to Space submenu present')
  t.is(go.submenu.length, 9, 'only the first nine spaces get a chord')
  t.is(go.submenu[0].label, 'Space 0', 'first item is the first space')
  t.is(go.submenu[0].accelerator, 'CmdOrCtrl+1', 'first space bound to mod+1')
  t.is(go.submenu[8].accelerator, 'CmdOrCtrl+9', 'ninth space bound to mod+9')
})

test('Go to Space is omitted with no spaces and escapes Windows mnemonics', (t) => {
  const empty = find(buildAppMenuTemplate({ ...baseOpts, platform: 'darwin' }), 'View').submenu
  t.absent(findInSubmenu(empty, 'Go to Space'), 'no empty submenu when there are no spaces')

  const view = find(buildAppMenuTemplate({ ...baseOpts, platform: 'win32', spaces: [{ id: 'a', name: 'R&D' }] }), 'View').submenu
  t.is(findInSubmenu(view, 'Go to Space').submenu[0].label, 'R&&D', 'a lone & is escaped so it renders')
})

test('inSpace: false → Add Files / Add Folder / Invite disabled', (t) => {
  const tpl = buildAppMenuTemplate({ ...baseOpts, platform: 'darwin', inSpace: false })
  const file = find(tpl, 'File').submenu
  t.is(findInSubmenu(file, 'Add Files…').enabled, false, 'Add Files disabled')
  t.is(findInSubmenu(file, 'Add Folder…').enabled, false, 'Add Folder disabled')
  t.is(findInSubmenu(file, 'Invite People…').enabled, false, 'Invite disabled')
})

test('inSpace: true → Add Files / Add Folder / Invite enabled', (t) => {
  const tpl = buildAppMenuTemplate({ ...baseOpts, platform: 'darwin', inSpace: true })
  const file = find(tpl, 'File').submenu
  t.is(findInSubmenu(file, 'Add Files…').enabled, true, 'Add Files enabled')
  t.is(findInSubmenu(file, 'Add Folder…').enabled, true, 'Add Folder enabled')
  t.is(findInSubmenu(file, 'Invite People…').enabled, true, 'Invite enabled')
})

test('win32 / linux: File menu ends with Quit (Ctrl+Q), no Close Window', (t) => {
  for (const platform of ['win32', 'linux']) {
    const tpl = buildAppMenuTemplate({ ...baseOpts, platform, appName: 'Mirall' })
    const file = find(tpl, 'File').submenu
    const quit = findInSubmenu(file, 'quit')
    t.ok(quit, `${platform}: Quit item present`)
    t.is(quit.label, 'Quit Mirall', `${platform}: Quit label uses appName`)
    t.is(quit.accelerator, 'CmdOrCtrl+Q', `${platform}: Quit bound to Ctrl+Q`)
    t.absent(findInSubmenu(file, 'close'), `${platform}: no Close Window in File menu`)
  }
})

test('darwin: File keeps Close Window; Quit stays in app menu', (t) => {
  const tpl = buildAppMenuTemplate({ ...baseOpts, platform: 'darwin' })
  const file = find(tpl, 'File').submenu
  t.ok(findInSubmenu(file, 'close'), 'Close Window present in mac File menu')
  t.absent(findInSubmenu(file, 'quit'), 'no Quit in mac File menu')
  const appMenu = find(tpl, 'Mirall').submenu
  t.ok(findInSubmenu(appMenu, 'quit'), 'Quit remains in mac app menu')
})

test('appName flows into About item and app submenu label', (t) => {
  const tpl = buildAppMenuTemplate({ ...baseOpts, platform: 'darwin', appName: 'Acme' })
  t.is(tpl[0].label, 'Acme', 'top-level app menu uses appName')
  const appMenu = tpl[0].submenu
  t.ok(findInSubmenu(appMenu, 'About Acme'), 'About item uses appName')

  const winLinux = buildAppMenuTemplate({ ...baseOpts, platform: 'win32', appName: 'Acme' })
  const help = find(winLinux, 'help').submenu
  t.ok(findInSubmenu(help, 'About Acme'), 'About in Help uses appName')
})
