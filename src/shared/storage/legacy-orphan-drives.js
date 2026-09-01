import { createLocalBee } from '../core/store.js'

const MIGRATION_FLAG = 'legacy-orphan-drive-reclaim-v1'

// A drive holding file blobs cannot be created any more — the overlay serves from the source file
// and copies nothing into a space drive — so any on disk were left by a pre-overlay build whose
// space was dropped without purging its cores. Reclaiming them was the one job of the retired
// "Free up space" action that must not become a recurring sweep: it can free gigabytes, which is
// why it used to be user-driven with a preview. One pass against a shape nothing produces any
// more is the safe form of that, so the boot sweep widens its categories exactly once.
export async function shouldReclaimOrphanDrives() {
  const flagBee = createLocalBee('app-migrations')
  try {
    await flagBee.ready()
    return !(await flagBee.get(MIGRATION_FLAG))?.value?.completedAt
  } finally {
    try { await flagBee.close() } catch {}
  }
}

export async function markOrphanDrivesReclaimed(purged) {
  const flagBee = createLocalBee('app-migrations')
  try {
    await flagBee.ready()
    await flagBee.put(MIGRATION_FLAG, { completedAt: Date.now(), purged })
  } finally {
    try { await flagBee.close() } catch {}
  }
}
