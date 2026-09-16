// The owner's catalog: one replicated, SCK-encrypted Hyperbee per (owner, space) listing every
// file this peer shares there (path, size, mtime, content hash — metadata only; bytes are served
// by the overlay backend). Same cardinality as the per-space drive, so a share with N files is N
// keys, not N cores. The core key is published in the share record so peers open it read-only
// by key (peer-catalog.js). Opened here, written here, listed here, purged on leave here.
import b4a from 'b4a'
import { createBee, getStore, isStorageInconsistency } from '../core/store.js'
import { purgeCoreDk, purgeAlias } from '../storage/core-purge.js'
import { getSpace, getSpaceContentKey, isLegacySpace, LEGACY_SPACE_MESSAGE } from '../spaces/space.js'
import { AppError } from '../core/errors.js'
import { CODES } from '../contract/errors.js'
import { isInPlaceFilesEnabled } from '../core/runtime-config.js'
import { createLogger } from '../core/logger.js'
import { Subsystem } from '../core/subsystem.js'
import { prefixRange } from '../core/bee-keys.js'
import { fileKey, sharePrefixKey, catalogEntry, classifyEntryNode } from './catalog-keys.js'
import { entryTally } from './catalog-tally.js'

const log = createLogger('own-catalog')

const ownCatalogs = new Map()   // spaceId -> Hyperbee (writable)

// Notified with (spaceId) whenever OUR OWN catalog core appends, so the owner's listing refreshes
// when a batched flush lands rather than when publish is called. Installed by the overlay backend
// rather than imported, so this module keeps no dependency on the IPC layer.
let ownAppendHook = null
export function setOwnCatalogAppendHook(fn) { ownAppendHook = fn }

// Encrypted catalog cores live under a distinct name so they get a fresh keyPair/key —
// hypercore can't retro-encrypt an existing plaintext core, so encryption requires a new core.
const ENC_SUFFIX = '-e1'

// The pre-encryption core name. Read only by the catalog-encryption migration, which copies
// and purges the superseded plaintext core of a space created before catalog encryption.
export function plaintextCatalogName(spaceId, space) {
  const suffix = space?.driveSuffix
  return suffix ? 'space-catalog-' + spaceId + '-' + suffix : 'space-catalog-' + spaceId
}

// Tolerant of a missing record by design: purgeOwnCatalog resolves this name during space-leave
// AFTER the space record is deleted, so the leave path passes the record it already read. Never
// derive a name to WRITE into before the record is saved, or you fork a divergent core.
export function catalogNameForSpace(spaceId, space) {
  return plaintextCatalogName(spaceId, space) + ENC_SUFFIX
}

export async function ownCatalog(spaceId) {
  const cached = ownCatalogs.get(spaceId)
  if (cached) return cached
  const space = await getSpace(spaceId)
  // A pre-encryption space can never obtain an SCK, so say that rather than report a missing key:
  // callers surface a code the UI can explain instead of a raw Error out of the IPC handler.
  if (isLegacySpace(space)) {
    throw new AppError(CODES.SPACE_UNSUPPORTED, LEGACY_SPACE_MESSAGE)
  }
  const sck = getSpaceContentKey(spaceId, space)
  // A catalog MUST be SCK-encrypted; an OWN catalog always has an SCK (created ⇒ derivable,
  // joined+approved ⇒ vault), so a missing one is a fault, not plaintext.
  if (!sck) throw new Error('ownCatalog: space ' + spaceId + ' has no SCK')
  const bee = createBee(catalogNameForSpace(spaceId, space), { encryptionKey: sck })
  await bee.ready()
  ownCatalogs.set(spaceId, bee)
  // Attached at creation, so no writer or reader can forget it, and read through `ownAppendHook`
  // at fire time, so a bee opened before the backend installed the hook still reports. The guard
  // silences a session that is no longer this space's catalog: two concurrent misses build two
  // sessions of one core, and a dropped catalog would otherwise keep reporting.
  bee.core.on('append', () => { if (ownCatalogs.get(spaceId) === bee) ownAppendHook?.(spaceId) })
  return bee
}

export async function ownCatalogKeyHex(spaceId) {
  const bee = await ownCatalog(spaceId)
  return b4a.toString(bee.core.key, 'hex')
}

// The own catalog key. Published into the …Enc field so a reader knows from the FIELD to apply
// the SCK; the bare field is still read only for a peer whose record predates its own migration.
export async function ownCatalogPublish(spaceId) {
  return { keyHex: await ownCatalogKeyHex(spaceId), encrypted: true }
}

// The same key as a value the announce paths can publish unconditionally: null when loose files
// are off or the catalog cannot be resolved, so neither the handshake nor a boot backfill has to
// decide whether this space has one.
export async function ownLooseCatalogPublish(spaceId) {
  if (!isInPlaceFilesEnabled()) return null
  try { return await ownCatalogPublish(spaceId) } catch (err) { log.debug('own loose-catalog key resolve failed:', err.message); return null }
}

export async function advertise(spaceId, shareId, relPath, { size, mtime, contentHash = null }) {
  const bee = await ownCatalog(spaceId)
  await bee.put(fileKey(shareId, relPath), { size, mtime, contentHash })
}

export async function tombstone(spaceId, shareId, relPath) {
  const bee = await ownCatalog(spaceId)
  const key = fileKey(shareId, relPath)
  const node = await bee.get(key)
  if (!node) return
  await bee.put(key, { ...node.value, deletedAt: Date.now() })
}

export async function setMaterializedHash(spaceId, shareId, relPath, contentHash) {
  const bee = await ownCatalog(spaceId)
  const key = fileKey(shareId, relPath)
  const node = await bee.get(key)
  if (!node?.value || node.value.deletedAt) return
  if (node.value.contentHash === contentHash) return
  await bee.put(key, { ...node.value, contentHash })
}

export async function getOwnEntry(spaceId, shareId, relPath) {
  const bee = await ownCatalog(spaceId)
  const state = classifyEntryNode(await bee.get(fileKey(shareId, relPath)))
  return state && !state.removed ? catalogEntry(relPath, state) : null
}

// The writer interface a publish pass takes: the same four methods createCatalogBatch offers, so
// a caller picks direct writes or a batch without knowing which it holds.
export const ownCatalogWriter = { advertise, setMaterializedHash, tombstone, get: getOwnEntry }

export async function* listOwnShare(spaceId, shareId) {
  const bee = await ownCatalog(spaceId)
  const prefix = sharePrefixKey(shareId)
  for await (const node of bee.createReadStream(prefixRange(prefix))) {
    if (node.value?.deletedAt) continue
    yield catalogEntry(node.key.slice(prefix.length), node.value)
  }
}

// Single-pass tolerant fold over an own share: the display list AND folder-info both read from
// this one traversal, so the count can never disagree with the rows it shows. A storage
// inconsistency degrades to a partial result (the display contract); any other error propagates.
export async function collectOwnShare(spaceId, shareId, limit = Infinity) {
  const tally = entryTally(limit)
  try {
    for await (const entry of listOwnShare(spaceId, shareId)) tally.add(entry)
  } catch (err) {
    if (!isStorageInconsistency(err)) throw err
    let dk = '?'
    try { const bee = await ownCatalog(spaceId); dk = b4a.toString(bee.core.discoveryKey, 'hex').slice(0, 16) } catch {}
    log.warn(`own catalog read aborted (core ${dk}…): ${err.message} — returning partial listing for display`)
  }
  return tally.result()
}

// Tolerant listing for DISPLAY paths only (the renderer's file list): a corrupt core degrades the
// file list rather than blanking the share. MUTATING callers (scan, reconcile, resolveLooseName,
// presence sweeps, boot rehydrate) keep listOwnShare and still throw — they must never act on a
// partial listing.
export async function listOwnShareForDisplay(spaceId, shareId) {
  return (await collectOwnShare(spaceId, shareId)).entries
}

/** @internal */
export function dropOwnCatalog(spaceId) {
  ownCatalogs.delete(spaceId)
}

// Delete this space's own catalog core on leave. Closes the bee first so the purge can release
// its RocksDB session, then drops the alias so a same-name reopen after a rejoin doesn't resolve
// the deleted core. The leave flow deletes the space record BEFORE this runs, so it passes the
// record it already read. The discovery key is name-derived and independent of encryption, so
// no SCK is needed just to purge.
export async function purgeOwnCatalog(spaceId, space = null) {
  const rec = space || await getSpace(spaceId)
  const name = catalogNameForSpace(spaceId, rec)
  const bee = ownCatalogs.get(spaceId) || createBee(name)
  dropOwnCatalog(spaceId)
  await purgeCatalogCore(bee, name)
  // A pre-encryption space's real catalog carries no "-e1", so the purge above resolved a core
  // that never existed and the plaintext one — full file metadata, readable with no key — would
  // survive the leave with its alias still claimed. Nothing else reclaims an own-catalog core.
  if (isLegacySpace(rec)) await purgeLegacyPlaintextCatalog(spaceId, rec)
}

// Close a catalog bee and delete its core + alias. Shared by leave and the catalog-encryption
// migration. The discovery key is name-derived and independent of encryption, so opening
// plaintext to read it is fine even for a v2 core.
async function purgeCatalogCore(bee, name) {
  const cs = getStore()
  await bee.ready()
  const dk = b4a.toString(bee.core.discoveryKey, 'hex')
  try { await bee.close() } catch {}
  await purgeCoreDk(cs, dk)
  await purgeAlias(cs, cs.ns, name)
}

// The pre-encryption plaintext catalog bee for a now-v2 space — opened by the catalog-encryption
// migration to COPY its entries into the encrypted core before purgeLegacyPlaintextCatalog
// deletes it. A distinct name from the "-e1" core, so no alias collision.
export function openLegacyPlaintextCatalog(spaceId, space) {
  return createBee(plaintextCatalogName(spaceId, space))
}

export async function purgeLegacyPlaintextCatalog(spaceId, space) {
  const name = plaintextCatalogName(spaceId, space)
  await purgeCatalogCore(createBee(name), name)
}

export class OwnCatalogs extends Subsystem {
  // A leftover handle is dead by definition — its store is gone — so it is dropped rather than
  // refused: throwing here would turn a shutdown that ran out of budget into an app that will
  // not start.
  async _open() {
    if (ownCatalogs.size) {
      this.log.warn(`dropping ${ownCatalogs.size} own catalog handle(s) left by a previous instance`)
      await this._closeAll()
    }
  }

  // The append listeners sit on the core session, so closing the bee drops them too.
  async _closeAll() {
    const open = [...ownCatalogs.values()]
    ownCatalogs.clear()
    await Promise.allSettled(open.map((bee) => bee.close()))
  }

  async _close() { await this._closeAll() }
}
