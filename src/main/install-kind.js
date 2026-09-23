// How a packaged Linux build reached the disk. An AppImage's runtime exports APPIMAGE, and the
// autostart writer and the XDG integration already key on it; a .deb has no such variable and runs
// from the package's install root under /usr/lib. A packaged tree launched from anywhere else (an
// unpacked out/ directory) is neither.
//
// Pure: env and execPath are parameters so a unit test can pin every branch on any host.
const pkg = require('../../package.json')

const DEB_INSTALL_ROOT = `/usr/lib/${pkg.name}/`

function linuxInstallKind({ isLinux, isPackaged, env = process.env, execPath = process.execPath }) {
  if (!isLinux || !isPackaged) return 'none'
  if (env.APPIMAGE) return 'appimage'
  if (execPath.startsWith(DEB_INSTALL_ROOT)) return 'deb'
  return 'unpacked'
}

// Why OTA is off for this run, or null when it is on. A .deb install is updated by its package
// manager, and the swap target under /usr/lib belongs to root; a source build has no upgrade key
// baked in, so the updater cannot be constructed at all.
function updatesOffReason({ installKind, updatesFlag, upgrade }) {
  if (installKind === 'deb') return 'deb-install'
  if (updatesFlag === false) return 'flag'
  if (!upgrade) return 'no-upgrade-key'
  return null
}

module.exports = { linuxInstallKind, updatesOffReason, DEB_INSTALL_ROOT }
