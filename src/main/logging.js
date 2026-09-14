// Renderer broadcast and main-process log forwarding.
//
// Installed first by the entry: installMainLogForwarding puts main's console into the log ring, and
// anything logged before it — the argv warnings, say — is absent from every diagnostics bundle.

const { webContents } = require('electron')
const { logRing } = require('./log-ring')
const { isDebug } = require('./debug-gate.js')

let redactLinePromise = null
function loadRedactLine() {
  if (!redactLinePromise) {
    redactLinePromise = import('../shared/core/diagnostics-redact.js')
      .then((m) => m.redactLine)
      .catch((err) => {
        console.error('[main] redaction module unavailable:', err.message)
        return null
      })
  }
  return redactLinePromise
}

function sendToAll(channel, payload) {
  for (const wc of webContents.getAllWebContents()) {
    if (wc.isDestroyed()) continue
    // A render frame can be disposed while its webContents isn't yet destroyed (teardown, a crashed
    // subprocess). wc.send then throws "Render frame was disposed"; swallow it per-target so the
    // failure can't propagate back into the log-forwarding console override below and feed a loop.
    try { wc.send(channel, payload) } catch {}
  }
}

// Mirror main-process console output into the renderer DevTools console while
// debug logging is on, so window.mirall.verbose surfaces BOTH worker and main
// logs in one place — main's own logs otherwise only reach the terminal, which a
// packaged user never sees. The original console still writes to stdout/stderr.
// Two guards prevent a feedback loop with the renderer→main console mirror in
// createWindow: we never forward main's own "[renderer …]" echo lines, and that
// mirror skips our "[main]" lines.
const MAIN_LOG_PREFIX = '[main]'
const RENDERER_ECHO_PREFIX = '[renderer '
function installMainLogForwarding() {
  const { format } = require('util')
  // Re-entrancy guard: forwarding a log calls sendToAll, and a failed send can itself be logged
  // (e.g. Electron's "Error sending from webFrameMain" when a frame is disposed). Without this flag
  // that log re-enters here, forwards again, fails again — an unbounded loop that hangs main.
  let forwarding = false
  for (const level of ['log', 'warn', 'error']) {
    const orig = console[level].bind(console)
    console[level] = (...args) => {
      orig(...args)
      const text = format(...args)
      logRing.push('main', level, text)
      if (!isDebug() || forwarding) return
      if (text.startsWith(RENDERER_ECHO_PREFIX)) return
      forwarding = true
      try { sendToAll('main:log', { level, text }) } catch {} finally { forwarding = false }
    }
  }
}

module.exports = { sendToAll, loadRedactLine, installMainLogForwarding, MAIN_LOG_PREFIX, RENDERER_ECHO_PREFIX }
