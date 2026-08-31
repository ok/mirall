// An optimistic row is dropped once the server listing surfaces the same path: the worker
// advertises a file while it is still hashing, so files:list carries it before the publish
// finishes. Keeping both would show the file twice, and the server row is the one that survives a
// remount.
export function mergeOptimistic (serverRows, optimisticRows) {
  if (optimisticRows.length === 0) return serverRows
  const known = new Set(serverRows.map((row) => row.path))
  const pending = optimisticRows.filter((row) => !known.has(row.path))
  if (pending.length === 0) return serverRows
  return [...pending, ...serverRows]
}
