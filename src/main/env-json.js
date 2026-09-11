// JSON-valued environment knobs (test/debug overrides). A knob is optional by definition, so a
// value this cannot use is ignored with a warning rather than thrown: these are set by hand and by
// the test harness, and a parse that throws takes its reader down with it.
//
// The value never reaches the warning. Main's console is mirrored into the log ring a diagnostics
// bundle ships, and JSON.parse's own message quotes a fragment of the input — which for these knobs
// is a bootstrap host/port list.
//
// Only a JSON object or array is accepted: a scalar parses fine but is not a shape any knob
// declares, and handing one on gives the consumer a value it cannot use.
function envJson(name) {
  const raw = process.env[name]
  if (!raw) return null
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    console.warn('[mirall] ignoring malformed ' + name + ': not valid JSON')
    return null
  }
  if (parsed === null || typeof parsed !== 'object') {
    console.warn('[mirall] ignoring ' + name + ': expected a JSON object or array')
    return null
  }
  return parsed
}

module.exports = { envJson }
