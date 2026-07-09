'use strict'

// Worker→main control frames ('main-request', e.g. start-watcher) are tiny — a command plus a
// few path args. Anything larger on the shared worker pipe is a worker→renderer response (e.g. a
// big file listing) that main has already broadcast and must NOT JSON.parse on its UI thread.
// This gate is what keeps a multi-MB response frame off main's main thread.
const MAIN_REQUEST_MAX_LINE = 64 * 1024

// True only for a non-empty line small enough to plausibly be a control frame. Generous vs. any
// real main-request, well under any large listing response.
function isControlFrameCandidate (line) {
  return line.length > 0 && line.length <= MAIN_REQUEST_MAX_LINE
}

module.exports = { MAIN_REQUEST_MAX_LINE, isControlFrameCandidate }
