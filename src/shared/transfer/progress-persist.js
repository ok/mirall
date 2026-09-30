// How often a download's byte count reaches its pending row. The live progress events stay on the
// ticker's cadence; the row only has to be fresh enough for the readers of the persisted bytes.

// Well under TRANSFER_QUIET_MS, so "is anything moving" never reads a live transfer as parked.
export const PROGRESS_PERSIST_MS = 2000

export function progressPersistDue(lastPersistedAt, now) {
  return now - lastPersistedAt >= PROGRESS_PERSIST_MS
}
