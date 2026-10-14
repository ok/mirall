import test from 'brittle'
import { downloadJob, looseShareFor, pendingKeyFor, rowShareFor, slotOwnedBy } from '../../src/shared/transfer/overlay/download-job.js'
import { catalogKeyField, readCatalogKey } from '../../src/shared/shares/catalog-keys.js'
import { entryRef } from '../../src/shared/contract/entry-ref.js'
import { LOOSE_SHARE_ID, looseTransferIdFor } from '../../src/shared/transfer/transfer-id.js'

const KEY = 'ab'.repeat(32)
const ENTRY = { contentHash: 'h1', size: 42, seq: 7 }
const FOLDER = { id: 'sh', name: 'Vault', displayName: 'My Vault', owner: 'OWNER' }
const MEMBER = { publicKey: 'OWNER', looseCatalogKeyEnc: KEY, looseCatalogEpoch: 0 }

const folderBase = {
  spaceId: 'S', share: FOLDER, relPath: 'sub/a.bin', pendingKey: '/Vault/sub/a.bin', keyHex: KEY, encrypted: true,
  entry: ENTRY, finalPath: '/dl/sub/a.bin',
}
const looseBase = {
  spaceId: 'S', share: looseShareFor(MEMBER), relPath: 'a.bin', pendingKey: '/a.bin', keyHex: KEY, encrypted: true,
  entry: ENTRY, finalPath: '/dl/a.bin',
}
const KINDS = [['folder', folderBase], ['loose', looseBase]]

test('a folder job carries every field the engine and its audit row read', (t) => {
  t.alike(downloadJob(folderBase), {
    spaceId: 'S', pendingKey: '/Vault/sub/a.bin', path: '/Vault/sub/a.bin', relPath: 'sub/a.bin', shareId: 'sh',
    ...catalogKeyField(KEY, true),
    folderName: 'My Vault',
    transferId: 'S|sh|sub/a.bin',
    contentHash: 'h1', size: 42, sourceSeq: 7,
    ownerKey: 'OWNER', verifyKey: entryRef('sh', 'sub/a.bin'),
    finalPath: '/dl/sub/a.bin', prevBytes: 0,
  })
})

test('a loose job is the same job on the loose share, with no folder to name', (t) => {
  const job = downloadJob(looseBase)
  t.alike(job, {
    spaceId: 'S', pendingKey: '/a.bin', path: '/a.bin', relPath: 'a.bin', shareId: LOOSE_SHARE_ID,
    ...catalogKeyField(KEY, true),
    folderName: null,
    transferId: looseTransferIdFor('S', 'a.bin'),
    contentHash: 'h1', size: 42, sourceSeq: 7,
    ownerKey: 'OWNER', verifyKey: entryRef(LOOSE_SHARE_ID, 'a.bin'),
    finalPath: '/dl/a.bin', prevBytes: 0,
  })
})

test('a partial resumes only into the destination its row recorded, on both kinds', (t) => {
  for (const [kind, base] of KINDS) {
    t.is(downloadJob({ ...base, prevFinalPath: base.finalPath, prevBytes: 10 }).prevBytes, 10, `${kind}: same destination resumes`)
    t.is(downloadJob({ ...base, prevFinalPath: '/old/a.bin', prevBytes: 10 }).prevBytes, 0, `${kind}: re-anchored starts from zero`)
    t.is(downloadJob({ ...base, prevFinalPath: base.finalPath }).prevBytes, 0, `${kind}: a row with no byte count starts from zero`)
  }
})

test('a missing size or seq degrades to what the engine expects, on both kinds', (t) => {
  for (const [kind, base] of KINDS) {
    const job = downloadJob({ ...base, entry: { contentHash: 'h1' } })
    t.is(job.size, 0, `${kind}: size`)
    t.is(job.sourceSeq, undefined, `${kind}: seq`)
  }
})

test('the job carries the epoch of the catalog it reads, defaulting to 0', (t) => {
  for (const [kind, base] of KINDS) {
    t.is(downloadJob(base).catalogEpoch, 0, `${kind}: default`)
    t.is(downloadJob({ ...base, epoch: 2 }).catalogEpoch, 2, `${kind}: carried`)
    t.absent('catalogEpoch' in downloadJob({ ...base, encrypted: false }), `${kind}: a plaintext catalog has no epoch`)
  }
})

test('the job names the folder by its label and survives an unreadable record', (t) => {
  t.is(downloadJob(folderBase).folderName, 'My Vault')
  t.is(downloadJob({ ...folderBase, share: { ...FOLDER, displayName: undefined } }).folderName, 'Vault')
  t.is(downloadJob(looseBase).folderName, null, 'a loose file has no folder')
})

// resolvePeerCatalog reads a descriptor through readCatalogKey, so the descriptor must resolve to
// exactly the catalog the member record names.
test('a loose descriptor resolves to the catalog its member names', (t) => {
  const members = {
    plaintext: { publicKey: 'P', looseCatalogKey: KEY },
    encrypted: { publicKey: 'P', looseCatalogKeyEnc: KEY, looseCatalogEpoch: 2 },
    'encrypted without an epoch': { publicKey: 'P', looseCatalogKeyEnc: KEY },
    keyless: { publicKey: 'P' },
  }
  for (const [name, member] of Object.entries(members)) {
    const share = looseShareFor(member)
    t.is(share.id, LOOSE_SHARE_ID, `${name}: the loose share`)
    t.is(share.owner, 'P', `${name}: owned by the member`)
    t.alike(readCatalogKey(share), readCatalogKey(member), `${name}: same catalog`)
  }
  t.alike(looseShareFor(undefined), { id: LOOSE_SHARE_ID, name: '', owner: null, catalogKey: null }, 'an unknown member is keyless')
})

test('a folder row with no readable record resolves through the key it carries', (t) => {
  const rows = {
    plaintext: { shareId: 'sh', ownerKey: 'OWNER', relPath: 'a.bin', overlayShare: true, catalogKey: KEY },
    encrypted: { shareId: 'sh', ownerKey: 'OWNER', relPath: 'a.bin', overlayShare: true, catalogKeyEnc: KEY, catalogEpoch: 3 },
  }
  for (const [name, row] of Object.entries(rows)) {
    const share = rowShareFor(row)
    t.is(share.id, 'sh', `${name}: the row's share`)
    t.is(share.owner, 'OWNER', `${name}: the row's owner`)
    t.alike(readCatalogKey(share), readCatalogKey(row), `${name}: same catalog`)
    t.is(downloadJob({ ...folderBase, share }).folderName, null, `${name}: no label to name`)
  }
})

// PERSISTED: the pending-row key and the claim key. A change orphans every row already on disk.
test('the pending key is the drive path for loose and the share-name path for a folder', (t) => {
  t.is(pendingKeyFor(looseShareFor(MEMBER), 'a.bin'), '/a.bin')
  t.is(pendingKeyFor(FOLDER, 'sub/a.bin'), '/Vault/sub/a.bin')
})

// One engine holds every share's slots, so an append on one share's catalog must not supersede
// another share's slot of the same owner.
test('an append reconciles only the slots of its own share and owner', (t) => {
  const loose = looseShareFor(MEMBER)
  const slot = (ownerKey, shareId) => ({ ownerKey, job: { shareId } })
  t.ok(slotOwnedBy(FOLDER)(slot('OWNER', 'sh')), 'the share\'s own slot')
  t.absent(slotOwnedBy(FOLDER)(slot('OWNER', LOOSE_SHARE_ID)), 'the same owner\'s loose slot')
  t.absent(slotOwnedBy(loose)(slot('OWNER', 'sh')), 'the same owner\'s folder slot')
  t.absent(slotOwnedBy(FOLDER)(slot('OTHER', 'sh')), 'another owner\'s slot of the same share id')
  t.ok(slotOwnedBy(loose)(slot('OWNER', LOOSE_SHARE_ID)), 'the loose share\'s own slot')
  t.absent(slotOwnedBy(FOLDER)({ ownerKey: 'OWNER' }), 'a slot without a job')
})
