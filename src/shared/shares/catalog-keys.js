// The catalog's key grammar: how an entry is addressed inside a catalog bee, how the catalog's own
// key is written into a record, and how an entry node is classified once read.
//
// One owner for the field convention, read and write, so a future variant cannot drift across the
// many sites that touch it. Pure — no bee, no space record, no store — which is what lets the four
// modules that only need the grammar stop importing the catalog itself.

// PERSISTED: this prefix addresses every entry inside a catalog bee. Changing it re-addresses
// every row a peer has already replicated.
export const FILE_PREFIX = 'file/'

export function sharePrefixKey(shareId) {
  return FILE_PREFIX + shareId + '/'
}

export function fileKey(shareId, relPath) {
  return sharePrefixKey(shareId) + relPath
}

// A canonical 32-byte core key in lowercase hex. A peer's catalog key is self-asserted (its
// handshake or profile bee), and a wrong-length or non-string value throws out of store.get.
const CATALOG_KEY_HEX = /^[0-9a-f]{64}$/

export function isValidCatalogKey(catalogKeyHex) {
  return typeof catalogKeyHex === 'string' && CATALOG_KEY_HEX.test(catalogKeyHex)
}

// The in-memory row every catalog read hands out for one live entry value.
export function catalogEntry(relPath, value) {
  return { relPath, size: value.size, mtime: value.mtime, contentHash: value.contentHash ?? null }
}

// The catalog-key field convention has ONE owner (read + write) so a future variant can't drift
// across the many sites that touch it. A v2 (SCK-encrypted) key lives in the '<prefix>Enc'
// field, a v1/plaintext key in '<prefix>'; prefix is 'catalogKey' for share records/jobs,
// 'looseCatalogKey' for profile/handshake/member records.
export function catalogKeyField(keyHex, encrypted, prefix = 'catalogKey') {
  return { [encrypted ? prefix + 'Enc' : prefix]: keyHex }
}

// Read the catalog key + whether it's encrypted from a share/member/job/pending record. The …Enc
// field wins; a plaintext key (written before catalog encryption, or by a peer that has not yet
// migrated) falls back. Recognises both the 'catalogKey' and 'looseCatalogKey' field pairs so one
// reader serves shares, members, and persisted rows.
export function readCatalogKey(rec) {
  const enc = rec?.catalogKeyEnc || rec?.looseCatalogKeyEnc || null
  if (enc) return { keyHex: enc, encrypted: true }
  return { keyHex: rec?.catalogKey || rec?.looseCatalogKey || null, encrypted: false }
}

// Map a raw catalog node to the consumer-visible entry state — the one place that encodes
// tombstone vs. mid-rehash vs. absent. null = absent/unreadable (UNKNOWN, never "removed").
// `seq` is the Hyperbee block the value lives at: monotonic per key, bumped by every re-write
// (so a remove+re-add lands a higher seq even for identical content), replicated identically
// across peers — the migration-free generation marker a receiver uses to spot a re-publish.
export function classifyEntryNode(node) {
  if (!node?.value) return null
  if (node.value.deletedAt) return { removed: true }
  return { removed: false, seq: node.seq, size: node.value.size, mtime: node.value.mtime, contentHash: node.value.contentHash ?? null }
}
