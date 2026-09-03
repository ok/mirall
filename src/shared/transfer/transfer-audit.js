// One audit row per finished consumer download, at its terminal outcome — never per chunk, and
// never per mirror-tick file (contract/audit-kinds.js records no per-file folder sync; a download
// the user asked for is not folder sync).
//
// Called by the download ENGINE, not by a channel. It used to live inside loose-overlay.js, which
// is why folder-share downloads silently recorded nothing for as long as the Activity Log has
// existed: recording an outcome is a step of the algorithm, identical for every channel, so a
// channel that forgets it is a bug the type system cannot see. The engine owns it now, and a
// channel added later is audited by construction.
//
// An integrity failure is promoted out of the generic failure kind because it is a security
// signal, not a network one: the bytes a holder served did not match the hash they advertised.
import path from 'bare-path'
import { record } from '../audit/audit-log.js'
import { getSpace } from '../spaces/space.js'
import { createLogger } from '../core/logger.js'

const log = createLogger('transfer-audit')

// Every recordTransferOutcome() still in flight. The write is a spaces-bee read followed by an
// audit-bee write in a microtask nobody holds, so without this a download landing during shutdown
// records nothing — the bug serve-ledger.js fixed as LIFECYCLE-2e and this path never did.
const pending = new Set()

// 'EHASHMISMATCH' is the raw vendor code; the engine maps it to TRANSFER_CHECKSUM before this is
// reached. Both are accepted so a caller that has not been through terminalCodeFor classifies the
// same way.
const INTEGRITY_CODES = new Set(['TRANSFER_CHECKSUM', 'EHASHMISMATCH'])

function kindFor(outcome, errorCode) {
  if (INTEGRITY_CODES.has(errorCode)) return 'security.integrity_failure'
  return outcome === 'ok' ? 'transfer.completed' : 'transfer.failed'
}

export function recordTransferOutcome(job, outcome, errorCode) {
  const fileName = path.basename(job.relPath || job.path || '')
  const write = getSpace(job.spaceId).then((space) => {
    record(kindFor(outcome, errorCode), {
      actor: { type: 'self' },
      space: { id: job.spaceId, name: space?.name ?? null },
      target: { kind: 'file', id: job.path ?? null, name: fileName || null },
      // ownerPublicKey, NOT ownerKey: no job in the codebase has an `ownerKey` field, so the old
      // spelling wrote null on every row it ever produced. `folder` is null for a loose file and
      // is what lets the viewer name the folder without a join — a row outlives its share.
      subject: {
        bytes: job.size ?? null,
        ownerKey: job.ownerPublicKey ?? null,
        folder: job.folderName ?? null,
        shareId: job.shareId ?? null,
      },
      outcome: outcome === 'ok' ? 'ok' : 'error',
      code: errorCode || null,
    })
  }).catch((err) => log.debug('transfer audit failed:', err.message))
  pending.add(write)
  write.finally(() => pending.delete(write))
}

// Awaits the writes already issued, bounded: a hung spaces-bee read must not hold the shutdown
// past its budget.
export async function drainTransferAudit({ settleMs = 2000 } = {}) {
  if (!pending.size) return
  await Promise.race([
    Promise.allSettled([...pending]),
    new Promise((resolve) => { const t = setTimeout(resolve, settleMs); t.unref?.() }),
  ])
  pending.clear()
}
