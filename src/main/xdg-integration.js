// Linux AppImage desktop integration. Extracted because it runs on exactly one platform, out of
// exactly one packaging format, and so cannot be exercised by running the app during development
// on any other — the only way to know the desktop entry it writes is well-formed is to assert it.
const fs = require('fs')
const path = require('path')

const ICON_SIZES = [16, 32, 48, 64, 128, 256]

function writeIfChanged(dest, contents) {
  try { if (fs.readFileSync(dest, 'utf8') === contents) return } catch {}
  fs.writeFileSync(dest, contents)
}

function copyFileIfChanged(src, dest) {
  try {
    const s = fs.statSync(src), d = fs.statSync(dest)
    if (s.size === d.size && s.mtimeMs <= d.mtimeMs) return
  } catch {}
  fs.copyFileSync(src, dest)
}

// Rewrites Exec= to the absolute AppImage path so the launcher entry self-heals if the user moves
// the AppImage, and declares the scheme handler so xdg-mime can pick this entry for mirall:// URLs.
// %U is what lets the desktop environment pass the URL through at all. StartupWMClass is the
// window's Wayland app ID, which is the lower-case package name, not the product name.
function desktopEntryFor(source, { appimage, mimeToken, wmClass }) {
  let desktop = source.replace(/^Exec=.*$/m, `Exec="${appimage}" %U`)
  desktop = /^StartupWMClass=/m.test(desktop)
    ? desktop.replace(/^StartupWMClass=.*$/m, `StartupWMClass=${wmClass}`)
    : desktop.replace(/(\n?)$/, `\nStartupWMClass=${wmClass}\n`)
  if (/^MimeType=/m.test(desktop)) {
    return desktop.replace(/^MimeType=(.*)$/m, (_m, list) => {
      const items = list.split(';').filter(Boolean)
      if (!items.includes(mimeToken)) items.push(mimeToken)
      return 'MimeType=' + items.join(';') + ';'
    })
  }
  return desktop.replace(/(\n?)$/, `\nMimeType=${mimeToken};\n`)
}

// The entry is written as <packageName>.desktop because KWin finds a window's icon by the file named
// exactly after its Wayland app ID (`mirall`); under the product name (`Mirall.desktop`) the title
// bar fell back to the generic Wayland icon. An entry left under the product name is removed, so the
// launcher lists Mirall once.
function integrateXdgLinux({ appName, packageName, protocol, isLinux, homedir, env = process.env, spawn }) {
  if (!isLinux || !env.APPIMAGE || !env.APPDIR) return false
  const appdir = env.APPDIR
  const appimage = env.APPIMAGE

  const srcDesktop = path.join(appdir, `${appName}.desktop`)
  if (!fs.existsSync(srcDesktop)) return false

  const mimeToken = 'x-scheme-handler/' + protocol
  const desktop = desktopEntryFor(fs.readFileSync(srcDesktop, 'utf8'),
    { appimage, mimeToken, wmClass: packageName })

  const appsDir = path.join(homedir, '.local', 'share', 'applications')
  fs.mkdirSync(appsDir, { recursive: true })
  // Removed before the write: on a case-insensitive filesystem the two names are one file.
  if (appName !== packageName) fs.rmSync(path.join(appsDir, `${appName}.desktop`), { force: true })
  writeIfChanged(path.join(appsDir, `${packageName}.desktop`), desktop)

  const iconsRoot = path.join(homedir, '.local', 'share', 'icons', 'hicolor')
  for (const size of ICON_SIZES) {
    const src = path.join(appdir, 'usr', 'share', 'icons', 'hicolor',
      `${size}x${size}`, 'apps', `${appName}.png`)
    if (!fs.existsSync(src)) continue
    const destDir = path.join(iconsRoot, `${size}x${size}`, 'apps')
    fs.mkdirSync(destDir, { recursive: true })
    copyFileIfChanged(src, path.join(destDir, `${appName}.png`))
  }

  // Detached + unref so we neither block startup nor care about the result. If the tool is
  // missing, the desktop environment picks the new entry up on its next scan anyway.
  const run = spawn || require('child_process').spawn
  try { run('update-desktop-database', [appsDir], { detached: true, stdio: 'ignore' }).unref() } catch {}
  try { run('xdg-mime', ['default', `${packageName}.desktop`, mimeToken], { detached: true, stdio: 'ignore' }).unref() } catch {}
  return true
}

// The reverse of integrateXdgLinux, for a build the package manager installed: the per-user entry
// and icons an earlier AppImage run wrote are removed, and the scheme is pointed at the packaged
// entry, so the launcher shows one Mirall and a mirall:// link opens the installed one. The per-user
// entry has the packaged entry's name, so it would shadow it; one under the product name is older.
function retireXdgAppImageEntry({ appName, protocol, packageName, homedir, spawn }) {
  const appsDir = path.join(homedir, '.local', 'share', 'applications')
  const userDesktops = [...new Set([packageName, appName])]
    .map((name) => path.join(appsDir, `${name}.desktop`))
    .filter((file) => fs.existsSync(file))
  if (userDesktops.length === 0) return false
  for (const file of userDesktops) fs.rmSync(file, { force: true })

  const iconsRoot = path.join(homedir, '.local', 'share', 'icons', 'hicolor')
  for (const size of ICON_SIZES) {
    fs.rmSync(path.join(iconsRoot, `${size}x${size}`, 'apps', `${appName}.png`), { force: true })
  }

  const mimeToken = 'x-scheme-handler/' + protocol
  const run = spawn || require('child_process').spawn
  try { run('update-desktop-database', [appsDir], { detached: true, stdio: 'ignore' }).unref() } catch {}
  try { run('xdg-mime', ['default', `${packageName}.desktop`, mimeToken], { detached: true, stdio: 'ignore' }).unref() } catch {}
  return true
}

// test seam: desktopEntryFor, writeIfChanged and copyFileIfChanged are exported for tests only.
module.exports = { integrateXdgLinux, retireXdgAppImageEntry, desktopEntryFor, writeIfChanged, copyFileIfChanged }
