// Bounded in-memory ring of recent log lines from all three processes. NEVER written to
// disk: it exists only to be attached to a diagnostics bundle the user explicitly saves.
const MAX_LINES = 2000
const MAX_BYTES = 512 * 1024
const MAX_LINE_LENGTH = 2000

class LogRing {
  constructor() {
    this._lines = []
    this._bytes = 0
  }

  push(source, level, text) {
    if (typeof text !== 'string') return
    for (const raw of text.split('\n')) {
      const trimmed = raw.trimEnd()
      if (!trimmed) continue
      const line = trimmed.length > MAX_LINE_LENGTH
        ? trimmed.slice(0, MAX_LINE_LENGTH) + '…[truncated]'
        : trimmed
      this._lines.push({ at: Date.now(), source, level, text: line })
      this._bytes += line.length
    }
    while (this._lines.length > MAX_LINES || this._bytes > MAX_BYTES) {
      const dropped = this._lines.shift()
      if (!dropped) break
      this._bytes -= dropped.text.length
    }
  }

  // Non-mutating: a preview followed by a save must not come back empty.
  snapshot(redactFn) {
    return this._lines.map((entry) => ({
      ...entry,
      text: redactFn ? redactFn(entry.text) : entry.text,
    }))
  }

  get size() {
    return this._lines.length
  }

  get bytes() {
    return this._bytes
  }
}

module.exports = { LogRing, logRing: new LogRing(), MAX_LINES, MAX_BYTES, MAX_LINE_LENGTH }
