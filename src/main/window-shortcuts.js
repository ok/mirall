// Classifies a Chromium before-input-event into a devtools toggle, a zoom command,
// or nothing. Pure + require-able so it's unit-tested without an Electron window.

function isDevtoolsChord(input) {
  if (input.key === 'F12') return true
  const key = input.key && input.key.toLowerCase()
  if (input.control && input.shift && key === 'i') return true
  if (input.meta && input.alt && key === 'i') return true
  return false
}

function matchWindowShortcut(input, { isMac }) {
  if (input.type !== 'keyDown') return null
  if (isDevtoolsChord(input)) return { kind: 'devtools' }

  const accel = isMac ? input.meta : input.control
  if (!accel) return null
  const key = input.key && input.key.toLowerCase()
  if (key === '=' || key === '+') return { kind: 'zoom', direction: 'in' }
  if (key === '-' || key === '_') return { kind: 'zoom', direction: 'out' }
  if (key === '0') return { kind: 'zoom', direction: 'reset' }
  return null
}

module.exports = { matchWindowShortcut, isDevtoolsChord }
