// One-shot: delete the per-space Hyperdrives earlier releases left in the store — this peer's own
// drive for each space, and the replicas of co-members' drives it opened by their participation id.
// An own drive holding blocks belongs to a space from before encryption, which this app no longer
// opens; it is left for that space's leave to delete. Without the master secret nothing can be
// derived, so the migration waits for a boot that has it.
import b4a from 'b4a'
import { getStore, createLocalBee, hasMasterSecret } from '../../core/store.js'
import { listSpaces } from '../../spaces/space.js'
import { purgeOwnRetiredDrive, purgeRetiredDrive } from '../retired-drive-cores.js'
import { createLogger } from '../../core/logger.js'
import { migrationResult, MIGRATION_STATUS } from './migration-result.js'

const log = createLogger('retire-space-drives')
const MIGRATION_FLAG = 'retire-space-drives-v1'
const HEX64 = /^[0-9a-f]{64}$/i

async function retireOwnDrive(space) {
  const result = await purgeOwnRetiredDrive(space, { keepWithBlocks: true })
  if (result.kept) log.warn('space drive holds blocks — left for its leave:', space.spaceId)
  return result
}

function memberDriveKeys(space) {
  return (space.members || []).map((m) => m.driveKey).filter((k) => typeof k === 'string' && HEX64.test(k))
}

export async function retireSpaceDrives() {
  if (!hasMasterSecret()) return migrationResult(MIGRATION_STATUS.DEFERRED)
  const flagBee = createLocalBee('app-migrations')
  try {
    await flagBee.ready()
    if ((await flagBee.get(MIGRATION_FLAG))?.value?.completedAt) return migrationResult(MIGRATION_STATUS.SKIPPED)
    const cs = getStore()
    let purged = 0
    let clearedBlocks = false
    const tally = (r) => { purged += r.purged; clearedBlocks ||= r.clearedBlocks }
    for (const space of await listSpaces()) {
      tally(await retireOwnDrive(space))
      for (const key of memberDriveKeys(space)) tally(await purgeRetiredDrive(cs, b4a.from(key, 'hex')))
    }
    await flagBee.put(MIGRATION_FLAG, { completedAt: Date.now(), purged })
    // Deleting an empty core frees a few header bytes; only cleared blocks are worth a full-range pass.
    return migrationResult(MIGRATION_STATUS.DONE, { compact: clearedBlocks, purged })
  } finally {
    try { await flagBee.close() } catch {}
  }
}
