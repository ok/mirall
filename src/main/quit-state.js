// Whether this process is on its way out.
//
// Set by the tray's Quit item and by the quit sequence; read by the worker writer (a write failure
// during teardown is expected, not a fault), by the window's close handler (which otherwise hides
// to tray instead of closing) and by the worker spawn path. One flag, four readers, no owner —
// so it lives here rather than in whichever module happens to set it first.

let quitting = false

module.exports = {
  isQuitting: () => quitting,
  markQuitting: () => { quitting = true },
}
