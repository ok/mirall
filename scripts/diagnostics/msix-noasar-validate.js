// Validates the noAsar-race theory AND the preload fix for the Windows OTA
// "Cannot find module 'msix-manager'" bug — WITHOUT cutting a new beta.
//
// Runs under Electron, in two modes:
//   reproduce — set process.noAsar = true cold, then `require('msix-manager')`
//               from pear-runtime-updater's context. Expected: FAIL with
//               MODULE_NOT_FOUND. This proves the noAsar window is the cause.
//   fix       — preload `require('msix-manager')` from pear-runtime-updater's
//               OWN context (via Module.createRequire(updaterIndex)) BEFORE
//               flipping process.noAsar = true. Expected: SUCCESS. This proves
//               the cache-warming fix actually warms the right cache.
//
// Run against the EXTRACTED MSIX (not the installed WindowsApps path — that
// hits the WindowsApps ACL on dlopen from outside the package container,
// which is unrelated to this bug):
//
//   # one extraction, two runs (separate processes for clean state):
//   npx electron scripts\diagnostics\msix-noasar-validate.js "C:\mirall-extract\app\resources" reproduce
//   npx electron scripts\diagnostics\msix-noasar-validate.js "C:\mirall-extract\app\resources" fix
//
// Expected outcomes:
//   reproduce: noasar_require_from_updater.ok = false, code = MODULE_NOT_FOUND
//   fix:       noasar_require_from_updater.ok = true,  value = "function"
//
// If both match, the fix lands cleanly; ship the beta. If reproduce passes
// (no failure), noAsar is NOT the cause and we have more digging to do. If
// fix fails despite preload, the preload context is wrong (or _pathCache key
// derivation differs from what we expect) — iterate before shipping.

const { app } = require('electron')
const path = require('path')
const Module = require('module')

const RES = process.argv[2]
const MODE = process.argv[3]
if (!RES || !['reproduce', 'fix'].includes(MODE)) {
  console.error('usage: npx electron scripts/diagnostics/msix-noasar-validate.js "<RESOURCES_DIR>" {reproduce|fix}')
  process.exit(2)
}

const asar = path.join(RES, 'app.asar')
const updaterIndex = path.join(asar, 'node_modules', 'pear-runtime-updater', 'index.js')

const report = {
  mode: MODE,
  when: new Date().toISOString(),
  electron: process.versions.electron,
  node: process.versions.node,
  platform: process.platform,
  arch: process.arch,
  resourcesDir: RES,
  steps: {},
}

function describeErr(e, depth = 0) {
  if (!e || depth > 5) return null
  return { message: e.message, code: e.code, cause: describeErr(e.cause, depth + 1) }
}
function rec(name, fn) {
  try { report.steps[name] = { ok: true, value: fn() } }
  catch (e) { report.steps[name] = { ok: false, ...describeErr(e) } }
}

app.whenReady().then(() => {
  if (MODE === 'fix') {
    // Mirror src/main/main.js's preloadAsarCache() hop exactly: createRequire
    // from pear-runtime-updater's OWN index.js so Node's pathCache key and
    // parent.paths match the updater's later lazy `require('msix-manager')`.
    rec('preload_via_createRequire_updater', () => {
      Module.createRequire(updaterIndex)('msix-manager')
      return 'warmed'
    })
  }

  // The exact failing operation, reproduced: applyUpdate runs inside
  // wrapWithNoAsar (process.noAsar = true) and does `require('msix-manager')`
  // from pear-runtime-updater's context.
  process.noAsar = true
  try {
    rec('noasar_resolve_from_updater', () => Module.createRequire(updaterIndex).resolve('msix-manager'))
    rec('noasar_require_from_updater', () => typeof Module.createRequire(updaterIndex)('msix-manager'))
  } finally {
    process.noAsar = false
  }

  const cwdOut = path.join(process.cwd(), `msix-noasar-validate-${MODE}.json`)
  try { require('fs').writeFileSync(cwdOut, JSON.stringify(report, null, 2)) } catch {}
  console.log(JSON.stringify(report, null, 2))
  app.quit()
})
