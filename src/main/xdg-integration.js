// Linux AppImage desktop integration. Extracted because it runs on exactly one platform, out of
// exactly one packaging format, and so cannot be exercised by running the app during development
// on any other — the only way to know the desktop entry it writes is well-formed is to assert it.
const fs = require('fs')
const path = require('path')

const ICON_SIZES = [16, 32, 48, 64, 128, 256]

function writeIfChanged (dest, contents) {
  try { if (fs.readFileSync(dest, 'utf8') === contents) return } catch {}
  fs.writeFileSync(dest, contents)
}

function copyFileIfChanged (src, dest) {
  try {
    const s = fs.statSync(src), d = fs.statSync(dest)
    if (s.size === d.size && s.mtimeMs <= d.mtimeMs) return
  } catch {}
  fs.copyFileSync(src, dest)
}

// Rewrites Exec= to the absolute AppImage path so the launcher entry self-heals if the user moves
// the AppImage, and declares the scheme handler so xdg-mime can pick this entry for mirall:// URLs.
// %U is what lets the desktop environment pass the URL through at all.
function desktopEntryFor (source, { appimage, mimeToken }) {
  let desktop = source.replace(/^Exec=.*$/m, `Exec="${appimage}" %U`)
  if (/^MimeType=/m.test(desktop)) {
    return desktop.replace(/^MimeType=(.*)$/m, (_m, list) => {
      const items = list.split(';').filter(Boolean)
      if (!items.includes(mimeToken)) items.push(mimeToken)
      return 'MimeType=' + items.join(';') + ';'
    })
  }
  return desktop.replace(/(\n?)$/, `\nMimeType=${mimeToken};\n`)
}

function integrateXdgLinux ({ appName, protocol, isLinux, homedir, env = process.env, spawn }) {
  if (!isLinux || !env.APPIMAGE || !env.APPDIR) return false
  const appdir = env.APPDIR
  const appimage = env.APPIMAGE

  const srcDesktop = path.join(appdir, `${appName}.desktop`)
  if (!fs.existsSync(srcDesktop)) return false

  const mimeToken = 'x-scheme-handler/' + protocol
  const desktop = desktopEntryFor(fs.readFileSync(srcDesktop, 'utf8'), { appimage, mimeToken })

  const appsDir = path.join(homedir, '.local', 'share', 'applications')
  fs.mkdirSync(appsDir, { recursive: true })
  writeIfChanged(path.join(appsDir, `${appName}.desktop`), desktop)

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
  try { run('xdg-mime', ['default', `${appName}.desktop`, mimeToken], { detached: true, stdio: 'ignore' }).unref() } catch {}
  return true
}

module.exports = { integrateXdgLinux, desktopEntryFor, writeIfChanged, copyFileIfChanged }
