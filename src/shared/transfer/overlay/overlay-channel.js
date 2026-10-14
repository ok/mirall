// The channel the download engine drives. One engine runs every share's downloads; what differs
// between the loose pseudo-share and a folder share is the small set of facts below, selected by the
// share id. Each is a persisted pending-row field, a wire event name or a renderer key, so none may
// change without a migration or a renderer change. Every member the engine calls is derived from
// them here, so a policy that holds for one kind holds for both by construction.
//
// Imports nothing from `bare-*`, so it loads under plain Node and unit-tests directly.
import { daemonPaths } from '../../contract/paths.js'
import { shareDecoKey } from '../../contract/decoration-key.js'
import { driveBaseName } from '../../folders/path-keys.js'
import { catalogKeyField, readCatalogEpoch } from '../../shares/catalog-keys.js'
import { LOOSE_SHARE_ID, transferIdFor, transferIdParts } from '../transfer-id.js'
import { isTerminalFault } from './fetch-policy.js'

const LOOSE = Object.freeze({
  diagLabel: 'loose download',
  updatedEvent: 'event:files-updated',
  // A loose row has no file list to surface an error inline in, so every code crosses the wire.
  surfaceAllErrors: true,
  decoKey: (job) => job.path,
  decoKeyForRow: (_row, pendingKey) => pendingKey,
  // PERSISTED, with ownsRow: a build owns a loose row by exactly these fields.
  pendingExtra: (job) => ({ inPlace: true, shareId: LOOSE_SHARE_ID, relPath: job.relPath }),
  ownsRow: (row) => row.inPlace === true && row.shareId === LOOSE_SHARE_ID,
})

const FOLDER = Object.freeze({
  diagLabel: 'overlay download',
  updatedEvent: 'event:share-files-updated',
  // A folder row surfaces its error inline in the file list (Resume retries), so only the codes no
  // automatic retry can fix cross the wire as a toast + notification.
  surfaceAllErrors: false,
  // Keyed shareId:relPath on the unified 'transfer' decoration channel; the renderer merges it at
  // render, gated on the worker-derived status, so an entry left after a missed `done` stays hidden.
  decoKey: (job) => shareDecoKey(job.shareId, job.relPath),
  decoKeyForRow: (row) => (row?.shareId && row?.relPath ? shareDecoKey(row.shareId, row.relPath) : null),
  // PERSISTED, with ownsRow. The catalog key lets a reconnect re-read the entry while the owner's
  // share record is unreadable.
  pendingExtra: (job) => ({
    inPlace: false, overlayShare: true, shareId: job.shareId, relPath: job.relPath,
    ...catalogKeyField(job.catalogKeyEnc || job.catalogKey, !!job.catalogKeyEnc, 'catalogKey', readCatalogEpoch(job)),
  }),
  ownsRow: (row) => row.overlayShare === true,
})

// Every job, row and transfer id names its share; one that does not would otherwise be written and
// announced as a folder's.
function kindOf(shareId) {
  if (!shareId) throw new Error('download channel: no share id')
  return shareId === LOOSE_SHARE_ID ? LOOSE : FOLDER
}

export function createOverlayChannel({ emit, resolvePendingRow }) {
  // Decoration frames carry spaceId: a bare drive path is unique per space only — without the
  // field two spaces downloading the same-named file would mix bytes in the renderer's per-key map.
  const deco = (spaceId, key, patch) => {
    if (key != null) emit('event:decoration', { channel: 'transfer', spaceId, key, ...patch })
  }
  const decoJob = (job, patch) => deco(job.spaceId, kindOf(job.shareId).decoKey(job), patch)

  return {
    // The fetch diagnostics' log label, so a support log still tells the two kinds apart.
    diagLabelFor: (job) => kindOf(job.shareId).diagLabel,
    // The pending bee also holds rows this engine never wrote; only these two shapes are its own.
    ownsPendingRow: (row) => LOOSE.ownsRow(row) || FOLDER.ownsRow(row),
    pendingExtra: (job) => kindOf(job.shareId).pendingExtra(job),
    transferIdForRow: (spaceId, row) => transferIdFor(spaceId, row.shareId, row.relPath),
    resolvePendingRow,

    // Progress is DECORATION (never status). Lifecycle events stay as signals for notifications;
    // the row's status is re-derived from the listing.
    emitProgress: (job, p) => decoJob(job, { bytes: p.bytes, total: p.total, speed: p.speed, eta: p.eta }),
    emitVerifying: (job, fraction) => decoJob(job, { phase: 'verifying', verifyFraction: fraction, bytes: job.prevBytes || 0, total: job.size }),
    emitDecorationDone: (job) => decoJob(job, { done: true }),
    emitUpdated: (spaceId, shareId) => emit(kindOf(shareId).updatedEvent, { spaceId }),

    emitError: (job, errorCode) => {
      if (kindOf(job.shareId).surfaceAllErrors || isTerminalFault(errorCode)) {
        emit('event:transfer-error', { transferId: job.transferId, spaceId: job.spaceId, path: job.path, errorCode })
      }
      decoJob(job, { done: true })
    },

    emitComplete: (job, localPath) => {
      emit('event:transfer-complete', daemonPaths({ transferId: job.transferId, spaceId: job.spaceId, path: job.path, localPath }))
      decoJob(job, { done: true })
    },

    // `retrying` means the engine has an automatic retry armed for this row. The decoration still
    // terminates (a stranded entry samples speed across the whole backoff), but the notification is
    // withheld: 'event:transfer-paused' raises an OS notification, and one per attempt would turn a
    // slow transfer into a stream of them.
    emitPaused: (job, reason, opts) => {
      if (!opts?.retrying) emit('event:transfer-paused', { transferId: job.transferId, spaceId: job.spaceId, path: job.path, reason })
      decoJob(job, { done: true })
    },

    emitSuperseded: (job) => {
      emit('event:transfer-superseded', { transferId: job.transferId, spaceId: job.spaceId, path: job.path, fileName: driveBaseName(job.relPath) })
      decoJob(job, { bytes: 0, total: job.size, speed: 0, eta: null })
    },

    // The cancel path has no job, but the pending row carries what the key needs (pendingExtra) —
    // emit the terminal done frame so the entry can't resurrect a stale bar when the same key
    // later re-derives 'downloading'.
    emitCancelled: (spaceId, transferId, pendingKey, row) =>
      deco(spaceId, kindOf(transferIdParts(transferId)?.shareId).decoKeyForRow(row, pendingKey), { done: true }),

    emitRemovedByOwner: (spaceId, pendingKey, row, transferId) =>
      emit('event:transfer-removed', { spaceId, transferId, path: pendingKey, fileName: driveBaseName(row?.relPath || pendingKey) }),
  }
}
