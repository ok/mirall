// The general-preferences record, and the one copy of it this process reads.
//
// Four places act on a preference change — the tray, the app menu, the window's close handler and
// window-all-closed — so the record is held here behind accessors rather than passed around as an
// object each of them could hold a stale copy of.

const PREFS_DEFAULTS = {
  minimizeToTray: true,
  openAtLogin: false,
  firstHideNoticeShown: false,
  appMenuAutoHide: false,
}

let prefs = { ...PREFS_DEFAULTS }
let configFor = null

function initPrefs({ config }) {
  configFor = config
  prefs = { ...PREFS_DEFAULTS, ...configFor().get('general') }
  return prefs
}

function getPrefs() {
  return prefs
}

// Replaces the record and persists it. Callers pass the whole next record, not a patch, because
// prefs:set has to compare the previous value of three fields before deciding what to re-apply.
function setPrefs(next) {
  prefs = next
  configFor().set('general', next)
  return prefs
}

module.exports = { PREFS_DEFAULTS, initPrefs, getPrefs, setPrefs }
