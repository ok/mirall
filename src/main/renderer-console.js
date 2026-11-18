'use strict'
// A window's console message, turned into the line the main log keeps. Pure, so a unit test drives
// it without a window.

// Electron names the lowest level `debug`; the log has always called it verbose.
const TAGS = { debug: 'VERBOSE', info: 'INFO', warning: 'WARNING', error: 'ERROR' }

/**
 * @param {{ level?: string, message?: unknown, lineNumber?: number, sourceId?: string }} details
 * @param {string} ownPrefix what the main process's own forwarded lines start with
 * @returns {{ tag: string, text: string } | null} null for a line that came from the main log
 */
function rendererLogLine(details, ownPrefix) {
  const { level, message, lineNumber, sourceId } = details || {}
  // Mirroring a forwarded main line back would feed the forwarding loop.
  if (typeof message === 'string' && message.startsWith(ownPrefix)) return null
  return { tag: TAGS[level] || 'INFO', text: `${sourceId}:${lineNumber} ${message}` }
}

module.exports = { rendererLogLine }
