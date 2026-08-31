import test from 'brittle'
import b4a from 'b4a'
import { freshDurableWithIdentity } from '../helpers/store.js'
import { setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { createSpace, joinSpace, mutateSpace } from '../../src/shared/spaces/space.js'
import { getLocalPublicKeyHex, readProfileRecord } from '../../src/shared/spaces/profile.js'
import { publishShare, readOwnShares } from '../../src/shared/shares/shares.js'
import { createBee, getStore } from '../../src/shared/core/store.js'
import { fileKey, ownCatalogKeyHex, collectOwnShare, legacyPlaintextCatalogName } from '../../src/shared/shares/share-catalog.js'
import { LOOSE_SHARE_ID } from '../../src/shared/transfer/loose-overlay.js'
import { migrateCatalogsToEncrypted } from '../../src/shared/shares/migrate-catalog-encrypt.js'

const SHARE = 'share-1'

async function coreInStore (dkHex) {
  for await (const dk of getStore().list()) {
    if (b4a.toString(dk, 'hex') === dkHex) return true
  }
  return false
}

// The durable tier only: boot() runs migrateCatalogsToEncrypted, and these tests drive it.
async function v2Peer (t) {
  const ctx = await freshDurableWithIdentity(t)
  setRuntimeConfig({ ...getRuntimeConfig(), overlayEnabled: true, inPlaceFilesEnabled: true })
  return ctx
}

// REGRESSION (FIX-326): the migration must COPY the plaintext catalog's entries into the encrypted
// core, not just purge + rely on a rescan — loose files (and offline-mount folders) are repopulated
// from the CATALOG, not disk, so an empty encrypted core loses them permanently.
test('migration copies folder AND loose entries into the encrypted core, then purges the plaintext one', async (t) => {
  await v2Peer(t)
  const space = await createSpace('Aurora')
  const spaceId = space.spaceId

  // Simulate a pre-#326 build's on-disk plaintext catalog: a folder entry + a loose entry, plus a
  // share record carrying the plaintext key. (createSpace already made the "-e1" encrypted core.)
  const legacyBee = createBee(await legacyPlaintextCatalogName(spaceId))
  await legacyBee.ready()
  const legacyKey = b4a.toString(legacyBee.core.key, 'hex')
  const legacyDk = b4a.toString(legacyBee.core.discoveryKey, 'hex')
  await legacyBee.put(fileKey(SHARE, 'a.txt'), { size: 3, mtime: 1, contentHash: 'hf' })
  await legacyBee.put(fileKey(LOOSE_SHARE_ID, 'loose.txt'), { size: 5, mtime: 2, contentHash: 'hl' })
  await legacyBee.close()
  await publishShare(spaceId, {
    id: SHARE, type: 'owned-folder', name: 'Docs', owner: getLocalPublicKeyHex(),
    contentMode: 'overlay', catalogKey: legacyKey, createdAt: 1,
  })
  t.ok(await coreInStore(legacyDk), 'precondition: legacy plaintext core present')

  const res = await migrateCatalogsToEncrypted()
  t.is(res.migrated, 1, 'migrated one v2 space')

  // The headline: both entries are now readable from the ENCRYPTED "-e1" catalog (collectOwnShare
  // reads ownCatalog). Without the copy, these are empty and the files vanish.
  const folder = await collectOwnShare(spaceId, SHARE)
  t.alike(folder.entries.map((e) => e.relPath), ['a.txt'], 'folder entry copied into the encrypted core')
  const loose = await collectOwnShare(spaceId, LOOSE_SHARE_ID)
  t.alike(loose.entries.map((e) => e.relPath), ['loose.txt'], 'loose entry copied into the encrypted core')
  t.is(loose.entries[0].contentHash, 'hl', 'copied entry keeps its content hash (mtime fast-path can fire)')

  t.absent(await coreInStore(legacyDk), 'legacy plaintext catalog core purged (closes the leak)')

  const encKey = await ownCatalogKeyHex(spaceId)
  const s = (await readOwnShares(spaceId)).find((x) => x.id === SHARE)
  t.is(s.catalogKeyEnc, encKey, 'share re-stamped with the encrypted catalog key')
  t.absent(s.catalogKey, 'legacy plaintext catalogKey stripped')

  const rec = await readProfileRecord(getLocalPublicKeyHex(), spaceId)
  t.is(rec.looseCatalogKeyEnc, encKey, 'encrypted loose-catalog key published')
  t.is(rec.looseCatalogKey, null, 'stale plaintext loosecat/ key cleared')

  t.alike(await migrateCatalogsToEncrypted(), { skipped: true }, 'second run is an idempotent no-op')
})

// REGRESSION (FIX-326): a v2 space we hold no SCK for (a pending joiner) must be DEFERRED, not
// marked complete — otherwise its plaintext catalog is never purged and never retried after approval.
test('defers a v2 space with no SCK and does not mark the migration complete', async (t) => {
  await v2Peer(t)
  await joinSpace('ab'.repeat(32), 'Pending', 'folder')

  const res = await migrateCatalogsToEncrypted()
  t.is(res.migrated, 0, 'nothing migrated')
  t.is(res.deferred, 1, 'the no-SCK space is deferred')
  t.absent((await migrateCatalogsToEncrypted()).skipped, 'not marked complete while a space is deferred (retries next boot)')
})

// A legacy space can never obtain an SCK, so counting it as "deferred" would hold the global flag
// open and re-run the whole pass on every boot for the life of the install.
test('a legacy space is skipped, not deferred — the migration still closes out', async (t) => {
  await v2Peer(t)
  const space = await createSpace('Ancient')
  await mutateSpace(space.spaceId, (s) => { const next = { ...s }; delete next.schemaVersion; return next })

  const res = await migrateCatalogsToEncrypted()
  t.is(res.deferred, 0, 'the legacy space is not deferred')
  t.ok((await migrateCatalogsToEncrypted()).skipped, 'the global flag closed out, so later boots no-op')
})
