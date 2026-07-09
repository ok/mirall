import test from 'brittle'
import { freshPeer, freshPeerWithIdentity } from '../helpers/store.js'
import { createSpace } from '../../src/shared/spaces/space.js'
import { ownCatalog, advertise, listOwnShare, listOwnShareForDisplay } from '../../src/shared/shares/share-catalog.js'
import { collectStoreCoreInfo, isStorageInconsistency, createDrive } from '../../src/shared/core/store.js'

// Patch a catalog bee so its read stream yields one entry then throws — simulating a
// backing core whose merkle tree is inconsistent (the exact error the replicator hits).
function patchCatalogFault (bee, makeError) {
  const real = bee.createReadStream.bind(bee)
  bee.createReadStream = (opts) => {
    const inner = real(opts)
    return (async function * () {
      let n = 0
      for await (const node of inner) {
        if (n++ === 1) throw makeError()
        yield node
      }
    })()
  }
}

// REGRESSION (FIX-1: a corrupt catalog core must not blank the share's file list, yet
// must NOT silently feed partial data to mutating callers). Repro: sharing a large file
// in overlay mode left a replicated core with a missing merkle tree node ("Expected tree
// node N from storage, got (nil)"); the own-catalog read threw out of share:list-files
// and the share rendered EMPTY. The DISPLAY path now degrades to a partial listing; the
// raw mutating listOwnShare still throws so scans/reconcile never act on partial data.
test('REGRESSION (FIX-1): display listing tolerates a storage-inconsistency fault; mutating listOwnShare fails loud', async (t) => {
  await freshPeer(t)
  const space = await createSpace('Aurora')
  const shareId = 'share-x'
  await advertise(space.spaceId, shareId, 'a.txt', { size: 1, mtime: 1 })
  await advertise(space.spaceId, shareId, 'b.txt', { size: 1, mtime: 1 })
  await advertise(space.spaceId, shareId, 'c.txt', { size: 1, mtime: 1 })

  const bee = await ownCatalog(space.spaceId)
  patchCatalogFault(bee, () => new Error('Expected tree node 15 from storage, got (nil)'))

  // Display path: tolerant → partial listing, no throw.
  const display = await listOwnShareForDisplay(space.spaceId, shareId)
  t.ok(display.length >= 1 && display.length < 3, `display path returns partial (${display.length}/3) instead of blanking the share`)

  // Mutating path: raw listOwnShare MUST still throw, so callers that tombstone/overwrite
  // based on what's absent never run on a partial listing.
  let threw = null
  try { for await (const _ of listOwnShare(space.spaceId, shareId)) { /* drain */ } } catch (err) { threw = err }
  t.ok(threw && isStorageInconsistency(threw), 'raw listOwnShare propagates the storage-inconsistency error (mutating paths fail loud)')
})

// The display guard is NARROW: it only swallows a storage inconsistency. Any other read
// fault (e.g. a real data-shape bug) must still propagate, not be mis-attributed as
// disk corruption and hidden behind a partial listing.
test('FIX-1: the display guard only swallows storage inconsistencies — other faults still throw', async (t) => {
  await freshPeer(t)
  const space = await createSpace('Aurora')
  const shareId = 'share-y'
  await advertise(space.spaceId, shareId, 'a.txt', { size: 1, mtime: 1 })
  await advertise(space.spaceId, shareId, 'b.txt', { size: 1, mtime: 1 })

  const bee = await ownCatalog(space.spaceId)
  patchCatalogFault(bee, () => new Error('some unrelated bee corruption'))

  let threw = null
  try { await listOwnShareForDisplay(space.spaceId, shareId) } catch (err) { threw = err }
  t.ok(threw, 'a non-storage-inconsistency fault is NOT swallowed by the display guard')
})

// The swarm peer-error names the PEER, not the core that failed to produce a replication
// proof. collectStoreCoreInfo (dumped by diagnoseStoreCores on a storage inconsistency)
// must name our open cores so the corrupt one can be pinned. Also guards against a
// corestore-internals shape change (alias registry / state.length).
test('collectStoreCoreInfo names open cores so a corrupt one can be pinned', async (t) => {
  await freshPeer(t)
  const space = await createSpace('Aurora')
  await advertise(space.spaceId, 's1', 'a.txt', { size: 1, mtime: 1 })
  await ownCatalog(space.spaceId) // ensure the catalog core is open

  const info = collectStoreCoreInfo()
  t.ok(info.length > 0, 'inventory enumerates open cores')
  const catalog = info.find((c) => c.name.startsWith('space-catalog'))
  t.ok(catalog, 'the space catalog core resolves to its registered name, not "(opened by key)"')
  t.ok(/^[0-9a-f]{16}$/.test(catalog.dk), 'discovery key captured')
  t.is(typeof catalog.len, 'number', 'length captured')
})

// FIX-5: a drive opens its blobs core BY KEY (no alias), so without explicit naming the
// inventory shows an OWN drive's blobs core — the likeliest large-file "Expected tree
// node" site — as "(opened by key)", indistinguishable from a peer core. createDrive
// names both the metadata and the blobs core.
test('FIX-5: createDrive names the drive metadata AND blobs cores', async (t) => {
  await freshPeerWithIdentity(t) // masterSecret path → metadata core is named too
  const drive = createDrive('diag-test-drive')
  t.teardown(async () => { try { await drive.close() } catch {} })
  await drive.ready()
  const blobs = await drive.getBlobs() // ensure the blobs core is open
  await blobs.core.ready()
  await Promise.resolve() // flush the rememberCoreName registration microtask

  const info = collectStoreCoreInfo()
  t.ok(info.find((c) => c.name === 'diag-test-drive'), 'drive metadata core is named')
  t.ok(info.find((c) => c.name === 'diag-test-drive:blobs'), 'drive blobs core is named (pinnable in the inventory)')
})
