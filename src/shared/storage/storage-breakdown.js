// The Storage screen's breakdown from measured core sizes. Pure, so the attribution rules are
// unit-tested without a store. `historyBytes` is replaced-record history no other row's estimate
// already holds. Whatever no category claims — profiles, settings, storage-engine files, deleted data
// awaiting compaction — is reported as "other", so the rows sum to the total unless the estimates
// overshoot it, where "other" is 0.

/**
 * @typedef {{ spaceId: string, name: string, own: string[], members: string[] }} SpaceCores
 * @typedef {{
 *   totalDiskUsage: number,
 *   coreBytes: Map<string, number>,
 *   spaces: SpaceCores[],
 *   indexBytes: number,
 *   activityLog: string[],
 *   downloadHistory: string[],
 *   historyBytes?: number,
 * }} BreakdownInput
 */

/** @param {BreakdownInput} input */
export function storageBreakdown({ totalDiskUsage, coreBytes, spaces, indexBytes, activityLog, downloadHistory, historyBytes = 0 }) {
  /** @param {string[]} dks */
  const sum = (dks) => dks.reduce((n, dk) => n + (coreBytes.get(dk) || 0), 0)
  const rows = spaces.map((s) => ({ spaceId: s.spaceId, name: s.name, ownCatalogBytes: sum(s.own), memberCatalogBytes: sum(s.members) }))
  const spaceTotal = (r) => r.ownCatalogBytes + r.memberCatalogBytes
  rows.sort((a, b) => spaceTotal(b) - spaceTotal(a))
  const activityLogBytes = sum(activityLog)
  const downloadHistoryBytes = sum(downloadHistory)
  const measured = rows.reduce((n, r) => n + spaceTotal(r), 0) + indexBytes + activityLogBytes + downloadHistoryBytes + historyBytes
  return {
    spaces: rows,
    indexBytes,
    activityLogBytes,
    downloadHistoryBytes,
    historyBytes,
    otherBytes: Math.max(0, totalDiskUsage - measured),
  }
}
