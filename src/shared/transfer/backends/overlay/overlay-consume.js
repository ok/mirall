// Consumer-side operations both download channels drive against their own engine instance.
import { activeSlotAction } from '../../supersede-decision.js'

// Cancel + discard every in-flight download for a space (leave teardown): the engine keeps fetching
// a started transfer even after its pending row is cleared, so without this the partial is orphaned
// and a late completion re-writes purged meta rows.
//
// Per-id best-effort: cancel throws when the row cannot be cleared, and the leave's own
// clearPendingForSpace purges the rows a beat later — one failed discard must not abort the leave.
export async function cancelSpaceOn (engine, spaceId, log) {
  const ids = []
  for (const [transferId, slot] of engine.activeSlots()) {
    if (slot.spaceId === spaceId) ids.push(transferId)
  }
  await Promise.all(ids.map((id) => engine.cancel(id).catch((err) => log.warn('cancel on leave failed:', id, '-', err.message))))
}

// Re-resolve every active slot this owner's catalog append could have invalidated, and apply the
// one decision ladder to each. `entryStateFor(slot)` reads the owner's current entry for the slot's
// path; `buildJob(slot, state)` produces the supersede job (null when it cannot be rebuilt).
export async function reconcileActiveSlots ({ engine, spaceId, ownsSlot, entryStateFor, buildJob, log }) {
  for (const [transferId, slot] of engine.activeSlots()) {
    if (slot.spaceId !== spaceId || !ownsSlot(slot)) continue
    const inflightHash = slot.contentHash
    const state = await entryStateFor(slot)
    const action = activeSlotAction(inflightHash, state, slot.sourceSeq)
    if (action === 'drop') {
      await engine.dropRemoved(spaceId, slot.pendingKey, transferId).catch((err) => log.debug('active drop-removed failed:', err.message))
      continue
    }
    if (action === 'pending') { engine.releaseForRepublish(transferId); continue }
    if (action !== 'restart') continue
    const job = await buildJob(slot, state, transferId)
    if (job) engine.supersede(transferId, job, inflightHash)
  }
}
