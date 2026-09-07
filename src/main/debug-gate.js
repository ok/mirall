// Main's live logging gate, in one place because five sections read it and one writes it.
//
// `verbose` seeds the worker bootstrap frame; `debug` gates main's own if-guarded logs. They are
// separate because the renderer dev console flips them together but a build can raise `debug`
// alone. Kept in a module rather than as module-level `let`s in main.js so the log forwarding can
// be installed before main.js has finished evaluating — reading a not-yet-initialised `let` from
// inside the patched console throws, and the first thing worth capturing (the argv warnings) is
// emitted before any of those bindings exist.
let baseDebug = false
let verbose = process.env.MIRALL_VERBOSE === '1'
let debug = false

// Called once main knows whether this is a dev run. Until then the gate reads false, which only
// suppresses forwarding — the log ring is written unconditionally by the caller either way.
function initDebugGate ({ isDev = false, env = process.env } = {}) {
  baseDebug = env.MIRALL_DEBUG === '1' || isDev
  verbose = env.MIRALL_VERBOSE === '1'
  debug = baseDebug
  return debug
}

function isDebug () {
  return debug
}

function isVerbose () {
  return verbose
}

// Turning verbose off reverts to the build default rather than to off, so a debug build that the
// user toggled twice is still a debug build. A non-boolean reports the state without changing it.
function setVerbose (on) {
  if (typeof on === 'boolean') {
    verbose = on
    debug = on || baseDebug
  }
  return debug
}

module.exports = { initDebugGate, isDebug, isVerbose, setVerbose }
