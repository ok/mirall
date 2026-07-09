// Suppresses watcher echo: code that writes into an owned folder's mount registers
// the absolute path here first, and the owned-folder fs-event handler consumes the
// entry instead of re-publishing the app's own write as if it were a user edit.
// Entries expire after a short TTL so a missed consume can't mute a later real edit.
const byShare = new Map()
const TTL_MS = 30_000

function ensureBucket(shareId) {
  let entry = byShare.get(shareId)
  if (!entry) {
    entry = new Map()
    byShare.set(shareId, entry)
  }
  return entry
}

export function ignorePathsFor(shareId) {
  const bucket = ensureBucket(shareId)
  return {
    add(absPath) { bucket.set(absPath, Date.now() + TTL_MS) },
    has(absPath) {
      const exp = bucket.get(absPath)
      if (!exp) return false
      if (Date.now() > exp) { bucket.delete(absPath); return false }
      return true
    },
    delete(absPath) { bucket.delete(absPath) },
  }
}

export function clearShareGuards(shareId) {
  byShare.delete(shareId)
}

setInterval(() => {
  const now = Date.now()
  for (const bucket of byShare.values()) {
    for (const [p, exp] of bucket) {
      if (now > exp) bucket.delete(p)
    }
  }
}, 60_000).unref?.()
