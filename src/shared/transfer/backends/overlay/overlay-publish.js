// The publish core folder shares and loose files share. Advertise FIRST with contentHash:null so
// the entry is visible to members the instant it is added (consumer status `preparing`), then hash
// and backfill (the catalog update replicates → consumer flips preparing→remote). The canonical
// bytes stay in the user's real file on disk; nothing is copied into a core.
import fs from 'bare-fs'
import { ownCatalogWriter } from '../../../shares/own-catalog.js'
import { createLogger } from '../../../core/logger.js'
import { getOverlay } from './overlay-instance.js'
import { makeServable } from './serve-registration.js'

const log = createLogger('overlay')

// Set on graceful shutdown so every in-flight publish's hash aborts promptly (the loop frees the
// event loop for teardown to win the parent's SIGKILL race). The half-advertised null-hash entry
// is intentionally left in place — boot rehydration re-hashes it, so a quit mid-index doesn't lose
// a file the user added.
let publishesAborting = false
export function abortInFlightPublishes() { publishesAborting = true }
export function resetOverlayPublish() { publishesAborting = false }

// onAdvertised(size) fires right after the advertise, before the slow hash, so a caller can refresh
// its UI at advertise-time; onProgress(len) gets the incremental hashed-byte count. Returns
// { changed, contentHash } — contentHash null only when the source is gone / not a file.
export async function publishContent(spaceId, shareId, relPath, absPath, { onAdvertised, onProgress, signal, catalog = ownCatalogWriter, force = false } = {}) {
  let st
  try { st = fs.statSync(absPath) } catch { return { changed: false, contentHash: null } }
  if (!st.isFile()) return { changed: false, contentHash: null }

  // Read through the catalog this publish writes through: a bulk batch can hold a materialized
  // hash for up to its flush window, and reading the bee instead would re-hash that file.
  // `force` is the deep pass having already proven the content changed under an unchanged
  // size+mtime — the one case this fast path is blind to.
  const prev = await catalog.get(spaceId, shareId, relPath)
  if (!force && prev && prev.size === st.size && prev.mtime === st.mtimeMs && prev.contentHash) {
    await makeServable({ spaceId, shareId, relPath, absPath, contentHash: prev.contentHash, size: st.size })
    return { changed: false, contentHash: prev.contentHash }
  }

  await catalog.advertise(spaceId, shareId, relPath, { size: st.size, mtime: st.mtimeMs, contentHash: null })
  // Awaited: the loose path records the owned-source link here, and it must commit BEFORE the
  // multi-minute hash so a quit mid-hash stays recoverable (the folder callback is synchronous).
  await onAdvertised?.(st.size)
  // Build the content hash AND the FastCDC chunk map in a single streaming read, so the first peer
  // fetch serves immediately instead of paying a full-file re-chunk before the first byte. The
  // by-hash map is durable in FileIndex (survives restart).
  //
  // The entry is now half-advertised (contentHash:null). If the hash fails or yields nothing, undo
  // it here — the one place both callers advertise through — so it does not linger as a stuck
  // "preparing"/"adding" entry. Once setMaterializedHash writes the real hash the entry is no
  // longer stuck; a later makeServable failure self-heals on the next reconcile, so it stays
  // outside the revert window. On shutdown (incl. getOverlay() gone null mid-teardown) the
  // null-hash entry is left for boot re-hash instead of unsharing the file.
  let contentHash
  try {
    const prep = await getOverlay()?.prepareForServe(absPath, { onProgress, signal: { get aborted() { return publishesAborting || Boolean(signal?.aborted) } } })
    if (!prep?.contentHash) {
      if (!publishesAborting) await revertHalfAdvertised(spaceId, shareId, relPath, prev, catalog)
      return { changed: false, contentHash: null }
    }
    contentHash = prep.contentHash
    await catalog.setMaterializedHash(spaceId, shareId, relPath, contentHash)
  } catch (err) {
    if (!publishesAborting) await revertHalfAdvertised(spaceId, shareId, relPath, prev, catalog)
    throw err
  }
  await makeServable({ spaceId, shareId, relPath, absPath, contentHash, size: st.size })
  return { changed: true, contentHash }
}

// Undo a half-advertised (contentHash:null) catalog entry after a failed publish: re-advertise the
// prior version on a re-publish, or tombstone a first publish. Non-throwing on purpose: the caller
// is about to rethrow the publish error, which this must not replace. A revert that fails leaves
// the entry visible to members as 'preparing' until the next scan or boot rehydrate re-hashes it,
// so the operator has to be told.
async function revertHalfAdvertised(spaceId, shareId, relPath, prev, catalog) {
  try {
    if (prev?.contentHash) {
      await catalog.advertise(spaceId, shareId, relPath, { size: prev.size, mtime: prev.mtime, contentHash: prev.contentHash })
    } else {
      await catalog.tombstone(spaceId, shareId, relPath)
    }
  } catch (err) {
    log.warn('could not revert a half-advertised entry — members see it as preparing until the next scan:', shareId, relPath, '-', err.message)
  }
}
