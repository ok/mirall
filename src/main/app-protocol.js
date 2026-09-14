// The app:// scheme the renderer loads from, and the boot-time warm-up that makes it safe.
//
// Everything the packaged app serves lives inside app.asar, and the OTA updater opens a noAsar
// window while applying — so every asar-internal read has to happen BEFORE that window, and is
// cached here. The scheme itself is registered as privileged at module scope in the entry, which
// Electron requires before app.ready.

const path = require('path')
const fs = require('fs')
const { isWindows } = require('which-runtime')
const { preloadEntrypoints } = require('./worker-entrypoints.js')
const { primeFeatureFlags } = require('./feature-flags.js')

const APP_PROTOCOL_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.map': 'application/json',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
}

// Preloaded at boot (see preloadAsarCache): the protocol handler serves from this map instead of
// reading app.asar per request, which would race the OTA updater's noAsar window (see
// wrapWithNoAsar). The assets/ payload is small enough to hold in RAM.
const APP_PROTOCOL_CACHE = new Map()

// repoRoot is injectable so a test can drive the boot-order rule below against a tree with no
// assets/ — the case the rule exists for.
function preloadAsarCache({ repoRoot = path.join(__dirname, '..', '..') } = {}) {
  // FIRST: everything below can throw (a missing assets/dist in a source checkout is an ENOENT out
  // of readdirSync), and this function has no catch. The allowlist is what pear:startWorker
  // resolves against, so losing it means the app refuses to spawn its OWN worker.
  preloadEntrypoints(repoRoot)

  const uiRoot = path.join(repoRoot, 'assets')
  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const e of entries) {
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) walk(abs)
      else if (e.isFile()) {
        const rel = path.relative(uiRoot, abs).split(path.sep).join('/')
        APP_PROTOCOL_CACHE.set(rel, fs.readFileSync(abs))
      }
    }
  }
  walk(uiRoot)

  // feature-flags.json is asar-internal too: read + cache it here, before getPear opens the
  // noAsar window, or a flag read in that window silently disables every flag.
  primeFeatureFlags(repoRoot)

  // pear-runtime-updater.applyUpdate lazily require()s msix-manager on win32 — inside the noAsar
  // window wrapWithNoAsar opens, where the resolution fails MODULE_NOT_FOUND and OTA never applies.
  // Warm Module._cache here, from the updater's OWN context (Module.createRequire(updaterIndex)):
  // Node's pathCache key includes the requiring module's parent.paths, so a preload from main.js's
  // context would not satisfy the updater's later lookup.
  if (isWindows) {
    const Module = require('module')
    const updaterIndex = require.resolve('pear-runtime-updater')
    Module.createRequire(updaterIndex)('msix-manager')
  }
}

function registerAppProtocol() {
  // Required here, not at module scope, so preloadAsarCache stays loadable under plain Node and its
  // boot-order rules can be driven by a unit test rather than scanned for.
  const { protocol: electronProtocol } = require('electron')
  electronProtocol.handle('app', async (request) => {
    let url
    try { url = new URL(request.url) } catch { return new Response('Bad Request', { status: 400 }) }
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html'
    if (rel.includes('..')) return new Response('Forbidden', { status: 403 })
    const data = APP_PROTOCOL_CACHE.get(rel)
    if (!data) return new Response('Not Found', { status: 404 })
    const mime = APP_PROTOCOL_MIME[path.extname(rel).toLowerCase()] || 'application/octet-stream'
    return new Response(data, { headers: { 'Content-Type': mime, 'Cache-Control': 'no-cache' } })
  })
}

module.exports = { preloadAsarCache, registerAppProtocol }
