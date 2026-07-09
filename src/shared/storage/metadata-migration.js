import b4a from 'b4a'
import { getStore, getStoragePath, createBee, createLocalBee, LOCAL_BEE_NAMES, hasMasterSecret } from '../core/store.js'
import { writeFileAtomic } from '../core/atomic-file.js'
import { purgeCoreDk } from '../spaces/space.js'
import { createLogger } from '../core/logger.js'

const log = createLogger('metadata-migration')
// Frozen on-disk marker: existing installs already carry this file, so the string
// must never change — changing it would re-run the migration on every install.
const MARKER = '.mir40-bees-v1'

// One-time compat pass: stores written by releases without at-rest encryption hold each
// local metadata bee in a plaintext core; this copies each one into the encrypted '/v2'
// core, then drops the plaintext core. Gated by a marker
// file so a normal boot does nothing; the marker lives inside app-storage so a
// later data backup captures it. Must run after setMasterSecret and before any
// init* opens these bees. Returns true if any bee was migrated (caller compacts
// to drop the scrubbed plaintext from superseded SST blocks). Never throws — a
// failure logs and leaves the marker unwritten so the next boot retries.
export async function migrateLocalBeesToEncrypted() {
  if (!hasMasterSecret()) return false
  try {
    await getStore().ready()
    const fs = (await import('bare-fs')).default
    const path = (await import('bare-path')).default
    const marker = path.join(getStoragePath(), MARKER)
    if (fs.existsSync(marker)) return false

    // A fresh install has no cores at all — skip the whole pass (and avoid
    // opening, hence creating, plaintext cores). On an existing install we open
    // each local bee; any with no data is purged too, so no plaintext metadata
    // core is left behind.
    let hasCores = false
    for await (const dk of getStore().list()) { if (dk) { hasCores = true; break } }

    const { migratedAny, allOk } = hasCores
      ? await migrateAllLocalBees()
      : { migratedAny: false, allOk: true }

    if (allOk) {
      await writeFileAtomic(marker, b4a.from('1'))
      log.info('local metadata bees encrypted at rest')
    }
    return migratedAny
  } catch (err) {
    log.warn('metadata-at-rest migration skipped (will retry next boot):', err.message)
    return false
  }
}

async function migrateAllLocalBees() {
  let migratedAny = false
  let allOk = true
  for (const name of LOCAL_BEE_NAMES) {
    try {
      if (await migrateOne(name)) migratedAny = true
    } catch (err) {
      log.warn('migrate', name, 'failed — will retry next boot:', err.message)
      allOk = false
    }
  }
  return { migratedAny, allOk }
}

async function migrateOne(name) {
  const enc = createLocalBee(name)
  const legacy = createBee(name)
  let purged = false
  try {
    await enc.core.ready()
    await legacy.core.ready()
    const dkHex = b4a.toString(legacy.core.discoveryKey, 'hex')
    // length, not an entry scan: a bee with data is header+data (>=2); a batch
    // flush is one atomic append, so enc.length<=1 means the copy hasn't landed.
    const hadData = legacy.core.length > 0
    if (hadData && enc.core.length <= 1) {
      const batch = enc.batch()
      for await (const { key, value } of legacy.createReadStream()) await batch.put(key, value)
      await batch.flush()
    }
    await enc.close()
    await legacy.close()
    await purgeCoreDk(getStore(), getStore().storage.db, dkHex)
    purged = true
    return hadData
  } finally {
    if (!purged) { await closeQuietly(enc); await closeQuietly(legacy) }
  }
}

async function closeQuietly(bee) {
  try { await bee.close() } catch {}
}
