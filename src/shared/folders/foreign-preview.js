// The mirror's read-only scan preview: what mounting this share at this path would download, and
// how much of it would land on top of something already there. Reads nothing the mirror engine
// owns — no loop state, no synced set — so it lives outside it.
import fs from 'bare-fs'
import { pathFromMount } from '../transfer/path-guard.js'
import { DEFAULT_IGNORE, dropUnsafeEntries } from './path-keys.js'
import { getContentBackend, hasContentBackend } from '../transfer/content-backends.js'
import { overlayHashFile } from '../transfer/backends/overlay/overlay-backend.js'
import { isVerifiedUnchanged } from '../transfer/files.js'
import { getListFilesCap } from '../core/runtime-config.js'
import { listingWillTruncate } from './share-limits.js'
import { createPreviewTally } from './preview-tally.js'
import { createLogger } from '../core/logger.js'
import { mapLimit } from '../core/concurrency.js'
import { AbortError, countDiskFiles } from './walk-disk.js'

const log = createLogger('foreign-preview')

const FOREIGN_PREVIEW_CONCURRENCY = 8
const PREVIEW_PROGRESS_EVERY = 16

// Resolve the peer share and enumerate its files from the overlay catalog.
// Returns null when the share isn't visible / has no usable content backend.
async function loadForeignListing(spaceId, ownerKey, shareId) {
  const { readPeerShares } = await import('../shares/shares.js')
  const shares = await readPeerShares(ownerKey, spaceId)
  if (!shares) return null
  const found = shares.find((s) => s.id === shareId)
  if (!found) return null
  const share = { ...found, spaceId, owner: ownerKey }
  if (!hasContentBackend(share)) return null
  const backend = getContentBackend(share)
  const { entries } = await backend.listPeerWithMeta(spaceId, share)
  return dropUnsafeEntries(
    entries.map((e) => ({ relPath: e.relPath, size: e.size, hash: e.contentHash })),
    (rel) => log.warn('refusing a peer file path that escapes the mount folder — skipping this entry (the owner drive may be malicious or corrupted):', rel),
  )
}

// Outcome of one remote entry vs the destination: absent -> download (no conflict); present but
// different -> download + conflict; present and identical -> skip. A size mismatch alone proves a
// conflict (different bytes can't hash-equal), and a verified-cache hit proves identity, so a
// content hash is read only for a same-size, uncached file. A non-ENOENT stat error means the file
// exists but is unreadable -> treat as a conflict.
async function classifyForeignEntry(entry, mountPath, spaceId, shareId, hashOf) {
  const abs = pathFromMount(mountPath, entry.relPath)
  let stat = null
  try {
    stat = await fs.promises.stat(abs)
  } catch (err) {
    if (err && err.code === 'ENOENT') return { relPath: entry.relPath, size: entry.size, download: true, conflict: false }
    return { relPath: entry.relPath, size: entry.size, download: true, conflict: true }
  }
  if (!stat.isFile()) return { relPath: entry.relPath, size: entry.size, download: true, conflict: true }
  if (stat.size !== entry.size) return { relPath: entry.relPath, size: entry.size, download: true, conflict: true }
  // `expectLocal` is what makes the record evidence about THIS path: the mirror writes the same key
  // when it lands the owner's bytes on a renamed sibling, and a manual download writes it for a
  // file in the downloads folder. Either one would otherwise report a clean destination for a file
  // the mount is about to download on top of the user's own.
  if (entry.hash && await isVerifiedUnchanged(spaceId, shareId + '|' + entry.relPath, entry.hash, entry.size, stat, { expectLocal: entry.relPath })) {
    return { relPath: entry.relPath, size: entry.size, download: false }
  }
  try {
    const onDisk = await hashOf(abs)
    if (entry.hash && onDisk === entry.hash) return { relPath: entry.relPath, size: entry.size, download: false }
    return { relPath: entry.relPath, size: entry.size, download: true, conflict: true }
  } catch {
    return { relPath: entry.relPath, size: entry.size, download: true, conflict: true }
  }
}

export async function previewMaterializeScan(spaceId, ownerKey, shareId, mountPath, opts = {}) {
  const { onProgress = null, signal = null, hashOf = overlayHashFile } = opts
  const checkAborted = () => { if (signal && signal.aborted) throw new AbortError() }
  const emit = (phase, scanned, total) => { if (onProgress) { try { onProgress({ phase, scanned, total, bytes: 0 }) } catch {} } }

  // Local count (disk) and remote listing (network) are independent — overlap them.
  emit('enumerating', 0, 0)
  const [existingAtDestination, entries] = await Promise.all([
    // Caught, not propagated: a preview of an unreadable destination reports zero rather than
    // failing the dialog the user is standing in front of.
    countDiskFiles(mountPath, DEFAULT_IGNORE).catch(() => 0),
    loadForeignListing(spaceId, ownerKey, shareId),
  ])
  checkAborted()

  // A preview that could not read the listing must not advise about its size: totalFiles 0 here
  // means "unknown", not "small".
  if (!entries) {
    return createPreviewTally().result('mount-foreign-folder', 'download', {
      existingAtDestination,
      totalFiles: 0,
      fileLimit: getListFilesCap(),
      overFileLimit: false,
      listingAdvisory: false,
    })
  }

  let scanned = 0
  const results = await mapLimit(entries, FOREIGN_PREVIEW_CONCURRENCY, async (entry) => {
    checkAborted()
    const r = await classifyForeignEntry(entry, mountPath, spaceId, shareId, hashOf)
    scanned += 1
    if (scanned % PREVIEW_PROGRESS_EVERY === 0) emit('scanning', scanned, entries.length)
    return r
  })
  emit('scanning', entries.length, entries.length)

  const tally = createPreviewTally()
  for (const r of results) {
    if (!r.download) continue
    tally.add({ relPath: r.relPath, size: r.size, conflict: !!r.conflict })
  }
  // overFileLimit is the wizard's REFUSAL flag and stays false for a mirror: mounting creates no
  // share, so the admission gate is not this flow's to enforce. listingAdvisory is the separate,
  // non-blocking fact — the folder screen already degrades for a truncated listing after the mount,
  // and this is the same news delivered before it.
  return tally.result('mount-foreign-folder', 'download', {
    existingAtDestination,
    totalFiles: entries.length,
    fileLimit: getListFilesCap(),
    overFileLimit: false,
    listingAdvisory: listingWillTruncate(entries.length),
  })
}
