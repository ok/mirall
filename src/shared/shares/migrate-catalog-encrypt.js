import { listSpaces, getSpaceContentKey } from '../spaces/space.js'
import { createLocalBee } from '../core/store.js'
import { readOwnShares, publishShare } from './shares.js'
import {
  ownCatalog, ownCatalogKeyHex, catalogKeyField,
  openLegacyPlaintextCatalog, purgeLegacyPlaintextCatalog,
} from './share-catalog.js'
import { markSpaceLooseCatalogKeyEnc } from '../spaces/profile.js'
import { createLogger } from '../core/logger.js'

const log = createLogger('catalog-encrypt-migration')
const FLAG = 'catalog-sck-encrypt-v1'
const spaceFlag = (spaceId) => FLAG + '/' + spaceId

// One-time, idempotent compat pass. v2 spaces created by releases before catalog encryption
// have a PLAINTEXT catalog — a pending joiner could list file metadata without the SCK (space
// content key). For each v2 space I own: COPY the plaintext
// catalog's entries into the new SCK-encrypted "-e1" core (so loose files + folders whose mount is
// offline at boot survive, and the scan's mtime fast-path still fires), publish the key into the
// …Enc fields, then PURGE the plaintext core — the purge is what closes the leak.
//
// A per-space marker makes retries cheap and skips already-migrated spaces; the global flag is only
// set once EVERY v2 space is done, so a space still awaiting its SCK (a pending joiner) is retried
// on later boots rather than silently left plaintext. v1 spaces are untouched.
export async function migrateCatalogsToEncrypted () {
  const flagBee = createLocalBee('app-migrations')
  await flagBee.ready()
  if ((await flagBee.get(FLAG))?.value?.completedAt) return { skipped: true }

  let migrated = 0
  let deferred = 0
  for (const space of await listSpaces()) {
    if (space.schemaVersion !== 2) continue
    const spaceId = space.spaceId
    if ((await flagBee.get(spaceFlag(spaceId)))?.value?.completedAt) continue
    if (!getSpaceContentKey(spaceId, space)) { deferred += 1; log.warn('defer v2 space without SCK (retry after approval):', spaceId); continue }
    try {
      await migrateOneCatalog(space, spaceId)
      await flagBee.put(spaceFlag(spaceId), { completedAt: Date.now() })
      migrated += 1
      log.info('migrated space catalog to SCK-encrypted:', spaceId)
    } catch (err) {
      log.warn('catalog encrypt migration failed for', spaceId, '-', err.message)
      return { skipped: false, migrated, retry: true }
    }
  }
  // Only close out the migration once no space is still waiting on its SCK.
  if (deferred === 0) await flagBee.put(FLAG, { completedAt: Date.now(), migrated })
  if (migrated) log.info('SCK-encrypted', migrated, 'space catalog(s)')
  return { skipped: false, migrated, deferred }
}

async function migrateOneCatalog (space, spaceId) {
  const enc = await ownCatalog(spaceId)
  const legacy = openLegacyPlaintextCatalog(space, spaceId)
  await legacy.core.ready()
  if (legacy.core.length > 0) {
    const batch = enc.batch()
    for await (const { key, value } of legacy.createReadStream()) await batch.put(key, value)
    await batch.flush()
  } else {
    log.info('no legacy plaintext catalog to copy for', spaceId)
  }
  try { await legacy.close() } catch {}

  const encKey = await ownCatalogKeyHex(spaceId)
  await markSpaceLooseCatalogKeyEnc(spaceId, encKey)
  for (const share of await readOwnShares(spaceId)) {
    if (share.catalogKeyEnc === encKey && share.contentMode === 'overlay' && !share.catalogKey) continue
    const { catalogKey, ...rest } = share
    await publishShare(spaceId, { ...rest, contentMode: 'overlay', ...catalogKeyField(encKey, true) })
  }
  await purgeLegacyPlaintextCatalog(space, spaceId)
}
