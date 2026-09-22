'use strict'

// One policy for a failure on the worker bus — a frame main could not write, a request main could
// not carry out. Debug logs every failure, including one racing teardown. Outside debug a quit is
// silent, because a half-written pipe or a request racing the watcher teardown is expected then.
// Any other failure goes to the caller's reporter, which decides how often it is said.

function errorText(err) {
  const message = err?.message
  return typeof message === 'string' ? message : String(err)
}

function createFailureGate({ isDebug, isQuitting }) {
  if (typeof isDebug !== 'function' || typeof isQuitting !== 'function') {
    throw new TypeError('a worker-bus failure gate needs isDebug and isQuitting')
  }
  // Runs inside catch blocks and a dispatch that must never reject, so reporting a failure cannot
  // become one: an error whose message or String() throws is dropped with the line.
  return function reportBusFailure(err, debugLine, report) {
    try {
      const text = errorText(err)
      if (isDebug()) console.error(...debugLine(text))
      else if (!isQuitting()) report(text)
    } catch {}
  }
}

module.exports = { createFailureGate }
