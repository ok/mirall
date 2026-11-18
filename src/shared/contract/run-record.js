// The note a running back end leaves beside its lock, so a client of the same profile can find the
// socket without recomputing its name. Advisory: the lock decides who holds the store, and a record
// whose socket does not answer is stale. Pure, so the app side reads it with the same parser.

export const RUN_RECORD_FILE = 'daemon.json'
export const RUN_RECORD_VERSION = 1

/**
 * @typedef {{ v: 1, socket: string, pid: number, version: string }} RunRecord
 */

/**
 * @param {{ socket: string, pid: number, version: string }} fields
 * @returns {string}
 */
export function serializeRunRecord({ socket, pid, version }) {
  return JSON.stringify({ v: RUN_RECORD_VERSION, socket, pid, version })
}

/**
 * The record the text holds, or null for anything malformed, of another version, or incomplete.
 * @param {string} text
 * @returns {RunRecord | null}
 */
export function parseRunRecord(text) {
  let raw
  try { raw = JSON.parse(text) } catch { return null }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (raw.v !== RUN_RECORD_VERSION) return null
  if (typeof raw.socket !== 'string' || raw.socket === '') return null
  if (!Number.isInteger(raw.pid) || raw.pid <= 0) return null
  if (typeof raw.version !== 'string' || raw.version === '') return null
  return { v: RUN_RECORD_VERSION, socket: raw.socket, pid: raw.pid, version: raw.version }
}
