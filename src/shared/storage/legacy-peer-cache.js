import Hyperdrive from 'hyperdrive'
import b4a from 'b4a'
import { listSpaces, getSpaceContentKey } from '../spaces/space.js'
import { getStore, createLocalBee } from '../core/store.js'
import { compactStore } from '../transfer/swarm.js'
import { getLocalPublicKeyHex } from '../spaces/profile.js'
import { HEX64 } from '../invite-envelope.js'
import { createLogger } from '../core/logger.js'

const log = createLogger('legacy-peer-cache')
const MIGRATION_FLAG = 'legacy-peer-cache-clear-v2'

// One-shot, flag-guarded compat cleanup. Stores written by releases with the discontinued
// copy-based download path cached every peer download's blocks in a per-member driveKey
// blobs core. The overlay backend never opens, measures, or clears those cores, so after
// an upgrade the cached bytes (potentially GBs) sit on disk invisibly (storage:info
// reports contentBytes:0) with no reclaim UI to clear them. Open each peer drive, clearAll
// its cached blocks — the driveKey metadata core stays "wanted" because the member's
// driveKey is signed into the handshake identity binding — then compact once so the disk
// drop is immediate. Never touches our own
// drive; best-effort per drive; uses clearAll (not a core purge) so the shared corestore
// session is never closed (Hyperdrive._close would kill the root store).
export async function reclaimLegacyPeerCaches () {
  const flagBee = createLocalBee('app-migrations')
  try {
    return await run(flagBee)
  } finally {
    try { await flagBee.close() } catch {}
  }
}

async function run (flagBee) {
  await flagBee.ready()
  if ((await flagBee.get(MIGRATION_FLAG))?.value?.completedAt) return { skipped: true }

  const me = getLocalPublicKeyHex()
  let cleared = 0
  for (const space of await listSpaces()) {
    const sck = getSpaceContentKey(space.spaceId, space)
    for (const member of (space.members || [])) {
      if (!member.driveKey || !HEX64.test(member.driveKey)) continue
      if (member.publicKey && member.publicKey === me) continue
      try {
        const drive = new Hyperdrive(getStore(), b4a.from(member.driveKey, 'hex'), sck ? { encryptionKey: sck } : {})
        await drive.ready()
        await drive.clearAll()
        // Release the sessions we opened (close the cores, NEVER drive.close() — that would
        // tear down the shared root corestore). The cores' data survives; a later open re-opens.
        try { await drive.blobs?.core.close() } catch {}
        try { await drive.db?.close() } catch {}
        cleared += 1
      } catch (err) {
        log.warn('legacy peer-cache clear failed:', member.driveKey.slice(0, 12), '-', err.message)
      }
    }
  }
  // clearAll tombstones the blocks (the logical reclaim); a compaction returns the bytes to the
  // OS. Await it (the whole migration is fire-and-forget from the worker boot, so this never
  // blocks boot) — the drives we opened are already closed above, so nothing fights the pass,
  // and completing it here means no compaction is left racing a short-lived process's exit.
  if (cleared > 0) {
    try { await compactStore() } catch (err) { log.warn('legacy peer-cache compaction failed:', err.message) }
  }
  await flagBee.put(MIGRATION_FLAG, { completedAt: Date.now(), cleared })
  if (cleared) log.info('reclaimed', cleared, 'legacy peer-drive cache(s)')
  return { skipped: false, cleared }
}
