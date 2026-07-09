// Sniff what kind of bee a core holds from a sample of its keys (the leftover scan's
// classifier — pure, so it is unit-testable).
// 'file-index' is the LOCAL overlay chunk-map bee. It must be a distinct kind so
// inspectCore never probes it as a Hyperdrive (a probe returns a derived empty
// blobs core → false 'orphan drive' → purge → data loss).
export function classifyBeeKind(sampleKeys) {
  if (sampleKeys.some((k) => k === 'displayName' || k === 'publicKey' || k.startsWith('member/'))) return 'profile'
  if (sampleKeys.some((k) => k.startsWith('file/'))) return 'catalog'
  if (sampleKeys.some((k) =>
    k.startsWith('chunkmap:') || k.startsWith('chunkmap-oid:') ||
    k.startsWith('tree:') || k.startsWith('treepath:') ||
    k.startsWith('file:') || k.startsWith('sync:') || k === 'config:sync')) return 'file-index'
  return 'orphan'
}
