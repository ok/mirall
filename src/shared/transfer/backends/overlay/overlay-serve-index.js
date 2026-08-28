// The overlay protocol is content-addressed *globally* (one hash → bytes,
// regardless of which space/path advertises it). The membership serve-gate needs
// the inverse: contentHash → which space(s) advertise it, so a request is allowed
// iff the asker is an approved member of at least one of them.
//
// Refcount by ADVERTISING PATH, not by space : content-addressed dedup means
// two paths — even two paths in the SAME space — can share one contentHash.
// Removing one path must NOT stop serving a hash another path still advertises,
// so each (spaceId, relPath) holds its own reference; a hash is forgotten only
// when its last reference drops. spacesFor returns the DISTINCT spaces among
// the live references (what the membership check iterates).
//
// In-memory only (like the facade's serve maps); rebuilt on boot from the
// owned catalogs by the backend's rehydrate pass (overlay-backend.js).

const EMPTY = new Set()
const SEP = String.fromCharCode(0) // NUL — cannot occur in a spaceId, shareId or a relPath
const hashToRefs = new Map() // contentHash → Set<spaceId + NUL + shareId + NUL + relPath>

function refKey(spaceId, shareId, relPath) {
  return spaceId + SEP + shareId + SEP + relPath
}

export const serveIndex = {
  add(contentHash, spaceId, shareId, relPath) {
    if (!contentHash || !spaceId || !shareId || !relPath) return // reject '' too, so add/remove keys can't desync
    let refs = hashToRefs.get(contentHash)
    if (!refs) hashToRefs.set(contentHash, (refs = new Set()))
    refs.add(refKey(spaceId, shareId, relPath))
  },

  // Returns true iff this dropped the hash's LAST reference (now unserved) — the
  // caller's signal that the durable chunk map for it can be evicted.
  remove(contentHash, spaceId, shareId, relPath) {
    const refs = hashToRefs.get(contentHash)
    if (!refs) return false
    refs.delete(refKey(spaceId, shareId, relPath))
    if (refs.size === 0) { hashToRefs.delete(contentHash); return true }
    return false
  },

  // The DISTINCT spaces advertising this hash (across all referencing paths).
  // Returns a shared EMPTY set when none — callers must treat it as read-only.
  spacesFor(contentHash) {
    const refs = hashToRefs.get(contentHash)
    if (!refs || refs.size === 0) return EMPTY
    const spaces = new Set()
    for (const ref of refs) spaces.add(ref.slice(0, ref.indexOf(SEP)))
    return spaces
  },

  // The (space, share, path) references advertising this hash — the inverse the
  // sender-side download indicator needs to map a served hash back to a file row.
  refsFor(contentHash) {
    const refs = hashToRefs.get(contentHash)
    if (!refs || refs.size === 0) return []
    const out = []
    for (const ref of refs) {
      const i = ref.indexOf(SEP)
      const j = ref.indexOf(SEP, i + 1)
      out.push({ spaceId: ref.slice(0, i), shareId: ref.slice(i + 1, j), relPath: ref.slice(j + 1) })
    }
    return out
  },

  has(contentHash) {
    return hashToRefs.has(contentHash)
  },

  // Whether THIS (space, share, path) still holds a reference on the hash — the reconcile's
  // cheap "already servable?" check before it re-registers an unchanged file.
  hasRef(contentHash, spaceId, shareId, relPath) {
    return hashToRefs.get(contentHash)?.has(refKey(spaceId, shareId, relPath)) === true
  },

  _reset() {
    hashToRefs.clear()
  },
}
