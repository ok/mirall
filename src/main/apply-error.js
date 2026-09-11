// The OTA apply journal. An update that fails to apply leaves no other trace a packaged user can
// send us — the console line never reaches them — so the failure is recorded here and reported in
// the diagnostics bundle, where it is the only evidence that a peer stopped receiving updates.
const fs = require('fs')
const path = require('path')

const identity = (line) => line

function applyErrorPath(dataDir) {
  return path.join(dataDir, 'pear-runtime', 'last-apply-error.json')
}

function recordApplyError(dataDir, err, { version, platform }) {
  try {
    const file = applyErrorPath(dataDir)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({
      timestamp: new Date().toISOString(),
      version,
      platform,
      message: err && err.message ? err.message : String(err),
      stack: err && err.stack ? err.stack : null,
    }, null, 2))
  } catch (writeErr) {
    console.error('record apply error failed:', writeErr)
  }
}

function clearApplyError(dataDir) {
  try { fs.rmSync(applyErrorPath(dataDir), { force: true }) } catch {}
}

// Live means: this build tried, failed, and has not succeeded since. A record written against a
// different version means the update landed in the end — or the user reinstalled over the top,
// which is the one path clearApplyError cannot cover, because no apply ever ran to clear it.
function isLiveApplyError(record, version) {
  return !!record && typeof record === 'object' && !Array.isArray(record) && record.version === version
}

// Built field by field rather than spread: the file is on disk and may have been edited, and the
// bundle is something a user hands to a stranger.
function toReport(record, redactLine = identity) {
  return {
    timestamp: typeof record.timestamp === 'string' ? record.timestamp : null,
    version: typeof record.version === 'string' ? record.version : null,
    platform: typeof record.platform === 'string' ? record.platform : null,
    message: redactLine(typeof record.message === 'string' ? record.message : ''),
    stack: typeof record.stack === 'string'
      ? record.stack.split('\n').map((line) => redactLine(line)).join('\n')
      : null,
  }
}

// Returns null — not an empty record — when there is nothing to report, so the bundle can leave the
// key out entirely on the installs where no apply has ever failed.
//
// Reading never deletes. Only recordApplyError and clearApplyError touch the file, so exporting a
// diagnostics bundle cannot destroy the one artifact it exists to carry. That matters in the
// direction the version gate alone reads wrong: a user who downgrades to work around a failed
// apply still has an unresolved failure, and pruning it during their export would take the
// evidence with it. Held instead, it is silent while they are on another version and reportable
// again the moment they return to the one it names.
function readLiveApplyError(dataDir, { version, redactLine }) {
  let record = null
  try {
    record = JSON.parse(fs.readFileSync(applyErrorPath(dataDir), 'utf8'))
  } catch {
    return null
  }
  if (!isLiveApplyError(record, version)) return null
  return toReport(record, redactLine || identity)
}

// test seam: applyErrorPath is exported for tests only.
module.exports = { applyErrorPath, recordApplyError, clearApplyError, readLiveApplyError }
