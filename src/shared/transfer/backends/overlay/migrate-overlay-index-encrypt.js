// One-time compat pass: stores written before overlay-index at-rest encryption hold the
// overlay's local index in PLAINTEXT cores under the 'mirall-overlay' namespace. This copies
// every entry into fresh, M-encrypted cores under 'mirall-overlay-e1', then clears + purges the
// plaintext cores (including their by-name aliases) so no cleartext metadata is left at rest and
// no dangling alias can wedge a later reopen. Gated by a marker in the app-migrations bee +
// hasMasterSecret; must run before the overlay backend opens the index. A purge failure propagates so
// the marker stays unwritten and the pass retries — leaving the plaintext cores marked-done-but-
// unpurged would defeat the whole point. The caller compacts the store when this reports migrated.
import { getStore, hasMasterSecret, overlayIndexEncryptionKey, createLocalBee } from '../../../core/store.js'
import { clearAndPurgeCore, purgeAlias } from '../../../spaces/space.js'
import { FileIndex, indexCoreName } from './vendor/file-index.js'
import { createLogger } from '../../../core/logger.js'

const log = createLogger('overlay-index-migration')

const FLAG = 'overlay-index-encrypt-v1'
const NS_PLAINTEXT = 'mirall-overlay'
const NS_ENC = 'mirall-overlay-e1'
// Flush the copy batch on EITHER cap. A paged chunk-map value can be several MB, so a
// count-only bound could buffer gigabytes and OOM the worker on a large index.
const MAX_BATCH_ENTRIES = 500
const MAX_BATCH_BYTES = 8 * 1024 * 1024

export async function migrateOverlayIndexToEncrypted() {
  if (!hasMasterSecret()) return { skipped: true }
  const flagBee = createLocalBee('app-migrations')
  try {
    const store = getStore()
    await store.ready()
    await flagBee.ready()
    if ((await flagBee.get(FLAG))?.value?.completedAt) return { skipped: true }

    const copied = await migrateIndex(store)
    await flagBee.put(FLAG, { completedAt: Date.now(), copied })
    if (copied) log.info('overlay index encrypted at rest — copied', copied, 'entries')
    return { skipped: false, migrated: copied > 0, copied }
  } catch (err) {
    log.warn('overlay-index at-rest migration skipped (will retry next boot):', err.message)
    return { skipped: false, retry: true }
  } finally {
    try { await flagBee.close() } catch {}
  }
}

async function migrateIndex(store) {
  const nsPlain = store.namespace(NS_PLAINTEXT)
  const legacy = new FileIndex(nsPlain)
  const enc = new FileIndex(store.namespace(NS_ENC), { encryptionKey: overlayIndexEncryptionKey() })
  try {
    await legacy.ready()
    await enc.ready()
    const version = legacy.version

    const copied = await copyBee(legacy.bee, enc.bee)
    await enc.close()
    await legacy.close()

    // Purge every plaintext generation (index-meta, sync-feed, and each file-index version),
    // dropping the by-name alias so a later reopen can't hit a dangling alias. Older generations
    // (v < current) left by an interrupted prior compaction are covered too. A failure throws.
    const names = ['index-meta', 'sync-feed']
    for (let v = 1; v <= version; v++) names.push(indexCoreName(v))
    for (const name of names) await purgePlaintextCore(store, nsPlain, name)

    return copied
  } finally {
    try { await enc.close() } catch {}
    try { await legacy.close() } catch {}
  }
}

async function copyBee(src, dst) {
  let copied = 0
  let batch = dst.batch()
  let count = 0
  let bytes = 0
  try {
    for await (const { key, value } of src.createReadStream()) {
      await batch.put(key, value)
      copied++
      count++
      bytes += key.length + approxValueBytes(value)
      if (count >= MAX_BATCH_ENTRIES || bytes >= MAX_BATCH_BYTES) {
        await batch.flush()
        batch = dst.batch()
        count = 0
        bytes = 0
      }
    }
    await batch.flush()
  } catch (err) {
    try { await batch.close() } catch {}
    throw err
  }
  return copied
}

// Cheap batch-sizing estimate — chunk-map arrays (the only multi-MB values) dominate; each
// { hash, offset, length } record is ~96 bytes of JSON.
function approxValueBytes(value) {
  if (Array.isArray(value)) return value.length * 96
  try { return JSON.stringify(value).length } catch { return 64 }
}

async function purgePlaintextCore(store, nsPlain, name) {
  const core = nsPlain.get({ name, valueEncoding: 'binary' })
  await core.ready()
  await clearAndPurgeCore(store, store.storage.db, core)
  await purgeAlias(store, nsPlain.ns, name)
}
