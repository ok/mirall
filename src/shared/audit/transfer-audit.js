// One audit row per finished consumer download, at its terminal outcome — never per chunk, and
// never per mirror-tick file (contract/audit-kinds.js records no per-file folder sync; a download
// the user asked for is not folder sync).
//
// Called by the download ENGINE, never by a channel, so every channel is audited by construction.
//
// An integrity failure is promoted out of the generic failure kind because it is a security
// signal, not a network one: the bytes a holder served did not match the hash they advertised.
import path from 'bare-path'
import { recordResolved } from './audit-log.js'
import { getSpace } from '../spaces/space.js'
import { OUTCOME, TARGET_KIND } from '../contract/audit-kinds.js'
import { selfActor, spaceRef, targetRef } from './audit-record.js'

// 'EHASHMISMATCH' is the raw vendor code; the engine maps it to TRANSFER_CHECKSUM before this is
// reached. Both are accepted so a caller that has not been through terminalCodeFor classifies the
// same way.
const INTEGRITY_CODES = new Set(['TRANSFER_CHECKSUM', 'EHASHMISMATCH'])

function kindFor(outcome, errorCode) {
  if (INTEGRITY_CODES.has(errorCode)) return 'security.integrity_failure'
  return outcome === OUTCOME.OK ? 'transfer.completed' : 'transfer.failed'
}

export function recordTransferOutcome(job, outcome, errorCode) {
  const fileName = path.basename(job.relPath || job.path || '')
  recordResolved(kindFor(outcome, errorCode), async () => {
    const space = await getSpace(job.spaceId)
    return {
      actor: selfActor(),
      space: spaceRef(job.spaceId, space?.name ?? null),
      target: targetRef(TARGET_KIND.FILE, job.path ?? null, fileName || null),
      // `folder` is null for a loose file and is what lets the viewer name the folder without a
      // join — a row outlives its share.
      subject: {
        bytes: job.size ?? null,
        ownerKey: job.ownerKey ?? null,
        folder: job.folderName ?? null,
        shareId: job.shareId ?? null,
      },
      outcome: outcome === OUTCOME.OK ? OUTCOME.OK : OUTCOME.ERROR,
      code: errorCode || null,
    }
  }, { context: { space: job.spaceId?.slice(0, 12) } })
}
