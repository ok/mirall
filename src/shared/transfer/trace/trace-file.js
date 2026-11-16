// The transfer trace on disk: lines appended to one file in the data folder, which is set aside as
// the previous file once it reaches its size limit, replacing the one set aside before. Two files
// bound what a run of any length can leave behind. A write that fails is dropped: the trace never
// fails the transfer it describes.
import fs from 'bare-fs'
import path from 'bare-path'

export const TRACE_DIR = 'transfer-trace'
export const TRACE_FILE = 'trace.ndjson'
export const TRACE_PREVIOUS_FILE = 'trace.previous.ndjson'
const MAX_BYTES_DEFAULT = 32 * 1024 * 1024

/** @param {string} storagePath */
export function traceDirFor(storagePath) {
  return path.join(path.dirname(storagePath), TRACE_DIR)
}

/** @param {{ dir: string, maxBytes?: number }} opts */
export function createTraceFile({ dir, maxBytes = MAX_BYTES_DEFAULT }) {
  const file = path.join(dir, TRACE_FILE)
  const previous = path.join(dir, TRACE_PREVIOUS_FILE)
  let size = 0
  try {
    fs.mkdirSync(dir, { recursive: true })
    size = fs.statSync(file).size
  } catch {}

  /** @param {string[]} lines */
  function append(lines) {
    if (lines.length === 0) return
    const text = lines.join('\n') + '\n'
    try {
      if (size > 0 && size + text.length > maxBytes) {
        fs.renameSync(file, previous)
        size = 0
      }
      fs.appendFileSync(file, text, { mode: 0o600 })
      size += text.length
    } catch {}
  }

  return { append, file, previous }
}
