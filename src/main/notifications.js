// Native notification host for the renderer: the notify:* IPC channels map to
// Electron's Notification, with per-id replacement (a re-shown id closes its
// predecessor), click routing back to the renderer, and a "show in folder"
// shell helper restricted to the user's home plus the configured download roots.
const { Notification, BrowserWindow, ipcMain, nativeImage, shell } = require('electron')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')

const active = new Map()
let revealWindowFn = null
let downloadRootsFn = () => []

// Windows caps a toast notification's Tag (the `id` option) and Group (the
// `groupId` option) at 64 UTF-16 code units, and Electron's Notification
// constructor throws above that. Our ids embed 64-hex-char public keys and full
// file paths (transferId = spaceId|shareId|relPath), so they routinely
// overflow. Replace any over-long value with a deterministic digest that fits:
// determinism keeps Windows toast replacement working (same logical id → same
// Tag), while the JS-side dedup map and click payload keep using the original id.
const WINDOWS_TOAST_TAG_LIMIT = 64

function toastSafeId(value) {
  if (value.length <= WINDOWS_TOAST_TAG_LIMIT) return value
  const sep = value.indexOf(':')
  const prefix = sep > 0 ? value.slice(0, sep + 1) : ''
  const digest = crypto.createHash('sha256').update(value).digest('hex')
  return (prefix + digest).slice(0, WINDOWS_TOAST_TAG_LIMIT)
}

// Per-platform because there is no neutral resources/icon.png — the repo only
// ships resources/{darwin,win32,linux}/icon.{icns,ico,png}. The path is handed
// to Electron's Notification, whose native backends (NSImage, Toast,
// libnotify) decode the platform-native format directly. nativeImage
// can't be used here because createFromPath only handles PNG/JPEG.
function defaultIconPath() {
  const rel =
    process.platform === 'darwin' ? 'darwin/icon.icns' :
    process.platform === 'win32' ? 'win32/icon.ico' :
    'linux/icon.png'
  return path.join(__dirname, '..', '..', 'resources', rel)
}

function resolveIcon(iconSpec) {
  if (!iconSpec) return defaultIconPath()
  if (typeof iconSpec === 'string' && iconSpec.startsWith('data:')) {
    const img = nativeImage.createFromDataURL(iconSpec)
    return img.isEmpty() ? defaultIconPath() : img
  }
  return iconSpec
}

function focusMainWindow() {
  if (revealWindowFn) {
    Promise.resolve(revealWindowFn()).catch((err) => console.error('revealWindow failed:', err))
    return
  }
  const win = BrowserWindow.getAllWindows()[0]
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

// The real containment helper, not a copy of it: `src/shared/package.json` marks that tree as
// ESM, which a CommonJS main can reach with a dynamic import (as deeplink.js already does for
// invite-envelope). A local reimplementation is what let the home branch and the roots branch
// of one authorization decision drift to different case-folding rules.
// Caught here, not at the await: an unhandled module-scope rejection would take down more than
// this feature, and an authorization check with no comparator must fail CLOSED.
const pathKeys = import('../shared/folders/path-keys.js').catch((err) => {
  console.error('[notifications] path-keys import failed, reveal disabled:', err.message)
  return null
})

// Only Windows genuinely case-folds. Folding on darwin too would authorize a DIFFERENT
// directory on a case-sensitive APFS volume (`/Volumes/Data/dl` vouching for
// `/Volumes/Data/DL`), and nothing needs it: every path compared here — the recorded
// localPath, the roots pushed by the worker — is produced by us from the same strings.
const FOLD_CASE = process.platform === 'win32'

// The renderer supplies this path and it ends at a shell call, so this is an authorization
// check: keep it a bounded allowlist of the user's home plus the configured download roots.
// Resolve BEFORE comparing, or `<root>/../../etc/passwd` passes a prefix test.
async function isRevealable(fullPath, roots) {
  if (typeof fullPath !== 'string' || fullPath.length === 0) return false
  const mod = await pathKeys
  if (!mod) return false
  const { pathContains } = mod
  const resolved = path.resolve(fullPath)
  const allows = (dir) =>
    typeof dir === 'string' && dir.length > 0 &&
    pathContains(path.resolve(dir), resolved, path.sep, FOLD_CASE)
  if (allows(os.homedir())) return true
  return Array.isArray(roots) && roots.some(allows)
}

function register(opts) {
  if (opts && typeof opts.revealWindow === 'function') revealWindowFn = opts.revealWindow
  if (opts && typeof opts.downloadRoots === 'function') downloadRootsFn = opts.downloadRoots

  ipcMain.handle('notify:isSupported', () => Notification.isSupported())

  ipcMain.handle('notify:show', (_evt, spec) => {
    if (!spec || typeof spec !== 'object') return { shown: false }
    if (!Notification.isSupported()) return { shown: false }

    const id = typeof spec.id === 'string' && spec.id.length > 0 ? spec.id : undefined

    if (id && active.has(id)) {
      try { active.get(id).close() } catch {}
      active.delete(id)
    }

    const options = {
      title: typeof spec.title === 'string' ? spec.title : '',
      body: typeof spec.body === 'string' ? spec.body : '',
      silent: !!spec.silent,
      urgency: spec.urgency === 'critical' || spec.urgency === 'low' ? spec.urgency : 'normal',
      icon: resolveIcon(spec.icon),
    }
    if (id) options.id = toastSafeId(id)
    if (typeof spec.groupId === 'string' && spec.groupId.length > 0) options.groupId = toastSafeId(spec.groupId)

    const n = new Notification(options)

    n.on('click', () => {
      const wc = BrowserWindow.getAllWindows()[0]?.webContents
      if (wc && !wc.isDestroyed()) {
        wc.send('notify:click', { id: id ?? null, payload: spec.payload ?? null })
      }
    })

    n.on('close', () => { if (id) active.delete(id) })

    if (id) active.set(id, n)
    n.show()
    return { shown: true, id: id ?? null }
  })

  ipcMain.handle('notify:isWindowFocused', () => {
    const win = BrowserWindow.getAllWindows()[0]
    return !!(win && !win.isDestroyed() && win.isFocused())
  })

  ipcMain.handle('notify:focus', () => { focusMainWindow() })

  ipcMain.handle('shell:showInFolder', async (_evt, fullPath) => {
    if (typeof fullPath !== 'string' || fullPath.length === 0) return { ok: false }
    if (!await isRevealable(fullPath, downloadRootsFn())) return { ok: false }
    shell.showItemInFolder(path.resolve(fullPath))
    return { ok: true }
  })
}

module.exports = { register, toastSafeId, isRevealable }
