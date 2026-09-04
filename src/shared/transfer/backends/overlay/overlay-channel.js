// The consumer-side channel the download engine drives, built from the small set of facts that
// actually differ between the loose pseudo-share and a folder share. Every member the engine calls
// is derived here, so a policy that holds for one channel holds for both by construction. The two
// hand-written bags this replaces had already drifted on the paused event and the error filter,
// and nothing could have caught it: from the compiler's point of view they were unrelated objects.
//
// Imports nothing from `bare-*` (and nothing from the two modules that build channels), so it
// loads under plain Node and unit-tests directly.
import { driveBaseName } from '../../../folders/path-keys.js'
import { ErrorCodes } from '../../../core/errors.js'

// Codes that reach the user directly on a channel whose rows have a list to fall back on.
// Everything else surfaces through the list refresh, where the row carries its own errorCode and
// offers Resume. The membership of this set and the auto-resume suppression in overlay-download.js
// are the same judgement: a fault the user must clear before a retry can ever succeed.
const USER_FACING_ERRORS = new Set([
  ErrorCodes.TRANSFER_DISK_FULL,
  ErrorCodes.TRANSFER_CHECKSUM,
  ErrorCodes.TRANSFER_DEST_UNAVAILABLE,
])

export function createOverlayChannel (d) {
  // Decoration frames carry spaceId: a bare drive path is unique per space only — without the
  // field two spaces downloading the same-named file would mix bytes in the renderer's per-key map.
  const deco = (spaceId, key, patch) => {
    if (key != null) d.emit('event:decoration', { channel: 'transfer', spaceId, key, ...patch })
  }
  const decoJob = (job, patch) => deco(job.spaceId, d.decoKeyFor(job), patch)

  return {
    diagLabel: d.diagLabel,
    inPlace: d.inPlace,
    ownsPendingRow: d.ownsPendingRow,
    pendingExtra: d.pendingExtra,
    transferIdForRow: d.transferIdForRow,
    resolvePendingRow: d.resolvePendingRow,

    // Progress is DECORATION (never status). Lifecycle events stay as signals for notifications;
    // the row's status is re-derived from the listing.
    emitProgress: (job, p) => decoJob(job, { bytes: p.bytes, total: p.total, speed: p.speed, eta: p.eta }),
    emitVerifying: (job, fraction) => decoJob(job, { phase: 'verifying', verifyFraction: fraction, bytes: job.prevBytes || 0, total: job.size }),
    emitDecorationDone: (job) => decoJob(job, { done: true }),
    emitUpdated: (spaceId) => d.emit(d.updatedEvent, { spaceId }),

    // `surfaceAllErrors` is the one asymmetry the two channels are allowed to keep, and it is a
    // real one: a folder row surfaces its error inline in the file list, a loose row has no such
    // list to fall back on.
    emitError: (job, errorCode) => {
      if (d.surfaceAllErrors || USER_FACING_ERRORS.has(errorCode)) {
        d.emit('event:transfer-error', { transferId: job.transferId, spaceId: job.spaceId, path: job.path, errorCode })
      }
      decoJob(job, { done: true })
    },

    emitComplete: (job, localPath) => {
      d.emit('event:transfer-complete', { transferId: job.transferId, spaceId: job.spaceId, path: job.path, localPath })
      decoJob(job, { done: true })
    },

    // `retrying` means the engine has an automatic retry armed for this row. The decoration still
    // terminates (a stranded entry samples speed across the whole backoff), but the notification is
    // withheld: 'event:transfer-paused' raises an OS notification, and one per attempt would turn a
    // slow transfer into a stream of them.
    emitPaused: (job, reason, opts) => {
      if (!opts?.retrying) d.emit('event:transfer-paused', { transferId: job.transferId, spaceId: job.spaceId, path: job.path, reason })
      decoJob(job, { done: true })
    },

    emitSuperseded: (job) => {
      d.emit('event:transfer-superseded', { transferId: job.transferId, spaceId: job.spaceId, path: job.path, fileName: driveBaseName(job.relPath) })
      decoJob(job, { bytes: 0, total: job.size, speed: 0, eta: null })
    },

    // The cancel path has no job, but the pending row carries what the key needs (pendingExtra) —
    // emit the terminal done frame so the entry can't resurrect a stale bar when the same key
    // later re-derives 'downloading'.
    emitCancelled: (spaceId, transferId, pendingKey, row) => deco(spaceId, d.decoKeyForRow(row, pendingKey), { done: true }),

    emitRemovedByOwner: (spaceId, pendingKey, row, transferId) =>
      d.emit('event:transfer-removed', { spaceId, transferId, path: pendingKey, fileName: driveBaseName(row?.relPath || pendingKey) }),
  }
}
