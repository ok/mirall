// Confirm-gone-twice: a path must be missing on two consecutive sweeps before its catalog entry is
// retired, so an atomic-save window (an editor's rename-over, a delete+recreate) cannot transiently
// tombstone a still-present file — which would cascade the deletion to every mirror peer.
//
// One policy, one Set, both owned-content sweeps. Pure (no bare-* imports): the caller supplies the
// key function, the in-flight probe, the presence probe and the retire.
export function createPresenceSweeper ({ keyOf, isPending, presentAt, retire }) {
  const gone = new Set()

  return {
    reset: () => gone.clear(),
    size: () => gone.size,

    // True when this entry was retired on THIS pass. `presentAt` returns null for an entry with no
    // recorded source — not ours to reclaim — and a boolean otherwise.
    async consider (ctx, entry) {
      const key = keyOf(ctx, entry)
      if (isPending(ctx, entry)) { gone.delete(key); return false }
      const present = await presentAt(ctx, entry)
      if (present !== false) { gone.delete(key); return false }
      if (!gone.has(key)) { gone.add(key); return false }
      gone.delete(key)
      await retire(ctx, entry)
      return true
    },
  }
}
