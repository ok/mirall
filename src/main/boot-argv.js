// Boot argv handling for the main process. Unlike a CLI, our argv is written by
// the OS rather than typed by a user: Windows and Linux hand a clicked
// mirall://join/<code> deep link to the process as a bare positional (macOS uses
// the open-url event instead), AppRun forwards --no-sandbox, and the shell may add
// switches of its own. paparam is strict by default and throws Bail on the first
// token it doesn't recognise; thrown while main.js is still evaluating, that
// surfaces as Electron's "A JavaScript error occurred in the main process" dialog
// and the process dies before any window, deep-link dispatch, or single-instance
// handler exists. So deep links are split off before parsing, and any remaining
// bail is downgraded to a warning: a surprising argv may cost us a flag, never
// the app.

const { command, flag, bail } = require('paparam')

const strings = (argv) => (Array.isArray(argv) ? argv.filter((a) => typeof a === 'string') : [])

// The one definition of "this argv entry is a deep link", shared by cold start
// (parseBootArgv) and the second-instance handler. URL schemes are
// case-insensitive, so the match is too.
function extractDeepLinks(argv, protocol) {
  if (typeof protocol !== 'string' || protocol === '') return []
  const prefix = protocol.toLowerCase() + '://'
  return strings(argv).filter((a) => a.toLowerCase().startsWith(prefix))
}

// Returns { flags, deepLinks, warnings }. flags is always an object, even when
// parsing bailed part-way; deepLinks preserves argv order.
function parseBootArgv(argv, { name = 'app', protocol = null } = {}) {
  const list = strings(argv)
  const deepLinks = extractDeepLinks(list, protocol)
  const isDeepLink = (a) => deepLinks.includes(a)
  const warnings = []

  const cmd = command(
    name,
    bail((b) => {
      const what = b?.flag?.name || b?.arg?.value || ''
      warnings.push(what ? `${b.reason}: ${what}` : String(b?.reason || 'bail'))
    }),
    flag('--storage <dir>', 'pass custom storage to pear-runtime'),
    flag('--no-updates', 'start without OTA updates'),
    flag('--hidden', 'start minimised to tray (used by autostart at login)'),
    // Chromium consumes --no-sandbox itself; declared here so a forwarded flag
    // parses cleanly instead of bailing out of the flags that follow it.
    flag('--no-sandbox', 'start without Chromium sandbox').hide()
  )
  cmd.parse(list.filter((a) => !isDeepLink(a)))

  return { flags: cmd.flags || {}, deepLinks, warnings }
}

module.exports = { parseBootArgv, extractDeepLinks }
