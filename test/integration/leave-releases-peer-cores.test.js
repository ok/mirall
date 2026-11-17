import test from 'brittle'
import b4a from 'b4a'
import Hyperbee from 'hyperbee'
import { freshPeer } from '../helpers/store.js'
import { makePeer, replicate } from '../helpers/peer-bee.js'
import { scaled } from '../helpers/bare-timing.js'
import { getStore } from '../../src/shared/core/store.js'
import { getSpace, upsertMember } from '../../src/shared/spaces/space.js'
import { createSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { purgeSpace } from '../../src/shared/spaces/leave-records.js'
import { openProfileBee } from '../../src/shared/spaces/peer-bee.js'
import { fetchPeerAvatar } from '../../src/shared/spaces/peer-profile-watch.js'
import { readPeerShares } from '../../src/shared/shares/shares.js'
import { collectPeerShare } from '../../src/shared/shares/peer-catalog.js'
import { forgetUnreferencedPeerCores } from '../../src/shared/storage/leftover.js'

// The peer publishes its shares under a space id of its own; readPeerShares only needs the id as
// a prefix, so the share outlives the local space record a leave deletes.
const S = 'space-rejoin'

async function sharingPeer(t) {
  const peer = await makePeer(t)
  await peer.bee.put('caps/folder-shares', true)
  await peer.bee.put('share/' + S + '/photos', { id: 'photos', name: 'Photos' })
  const catalogCore = peer.store.get({ name: 'catalog' })
  const catalog = new Hyperbee(catalogCore, { keyEncoding: 'utf-8', valueEncoding: 'json' })
  await catalog.put('file/loose/a.txt', { size: 1, mtime: 1 })
  peer.catalog = catalog
  peer.catalogKey = b4a.toString(catalogCore.key, 'hex')
  return peer
}

async function joinWith(peer, name) {
  const space = await createSpace(name)
  await upsertMember(space.spaceId, { publicKey: peer.key, displayName: 'Peer', looseCatalogKeyEnc: peer.catalogKey })
  const record = await getSpace(space.spaceId)
  return { space: record, member: record.members.find((m) => m.publicKey === peer.key) }
}

async function leave({ space, member }) {
  await purgeSpace(space.spaceId)
  return forgetUnreferencedPeerCores([member])
}

const shareIds = (shares) => (shares || []).map((s) => s.id).sort()
const looseNames = (read) => read.entries.map((e) => e.relPath).sort()

// The held watch is what a handshake arms (handshake-apply.js → fetchPeerAvatar), and it stays
// open for the process lifetime. A purge under it deleted the rows the open core still believed
// it had, so every read after a rejoin failed until a restart.
test('REGRESSION (FIX-REJOIN-1: a leave purged a peer profile core the watch still held open)', async (t) => {
  await freshPeer(t)
  const peer = await sharingPeer(t)
  replicate(getStore(), peer.store, t)

  const first = await joinWith(peer, 'Aurora')
  await fetchPeerAvatar(peer.key, { profileKey: peer.key, displayName: 'Peer' }, first.space.spaceId, first.space)
  t.alike(shareIds(await readPeerShares(peer.key, S)), ['photos'], 'precondition: the peer share reads')

  t.is((await leave(first)).purged, 1, 'the leave purges the profile core the watch held')
  await joinWith(peer, 'Aurora again')
  t.alike(shareIds(await readPeerShares(peer.key, S, scaled(3000))), ['photos'], 'the share reads again after the rejoin')

  await peer.bee.put('share/' + S + '/music', { id: 'music', name: 'Music' })
  t.alike(shareIds(await readPeerShares(peer.key, S, scaled(3000))), ['music', 'photos'], 'and so does one the peer adds afterwards')
})

// A reader of its own, outside the catalog cache: hyperbee's node cache cannot answer for it.
async function readFresh(keyHex, key) {
  const bee = new Hyperbee(getStore().get({ key: b4a.from(keyHex, 'hex') }), { keyEncoding: 'utf-8', valueEncoding: 'json' })
  try {
    await bee.ready()
    const timeout = new Promise((resolve) => setTimeout(() => resolve('timed out'), scaled(3000)))
    return await Promise.race([bee.get(key).then((node) => node?.value ?? null, (err) => err.code || err.message), timeout])
  } finally {
    await bee.close().catch(() => {})
  }
}

// The catalog cache keeps a Hyperbee per catalog key for the process lifetime, in the same way. Its
// node cache hides the damage from the cached bee itself; any other session on the core reads the
// deleted rows.
test('REGRESSION (FIX-REJOIN-2: a leave purged a peer catalog the catalog cache still held open)', async (t) => {
  await freshPeer(t)
  const peer = await sharingPeer(t)
  replicate(getStore(), peer.store, t)

  const first = await joinWith(peer, 'Aurora')
  const before = await collectPeerShare(peer.catalogKey, 'loose')
  t.alike(looseNames(before), ['a.txt'], 'precondition: the peer catalog reads')

  t.is((await leave(first)).purged, 1, 'the leave purges the catalog core the cache held')
  await joinWith(peer, 'Aurora again')
  await peer.catalog.put('file/loose/b.txt', { size: 2, mtime: 2 })
  const after = await collectPeerShare(peer.catalogKey, 'loose', { timeoutMs: scaled(3000) })
  t.alike(looseNames(after), ['a.txt', 'b.txt'], 'a file the peer adds after the rejoin lists')
  t.alike(await readFresh(peer.catalogKey, 'file/loose/a.txt'), { size: 1, mtime: 1 }, 'and the catalog reads outside the cache')
})

// The guard behind the release order: a session nobody released keeps its core, which stays
// readable, instead of being deleted underneath its holder.
test('REGRESSION (FIX-REJOIN-3: the peer core purge deleted a core a session still held)', async (t) => {
  await freshPeer(t)
  const peer = await sharingPeer(t)
  replicate(getStore(), peer.store, t)

  const first = await joinWith(peer, 'Aurora')
  const holder = openProfileBee(b4a.from(peer.key, 'hex'))
  t.teardown(() => holder.close().catch(() => {}))
  await holder.ready()
  await holder.core.update({ wait: true })
  t.alike(shareIds(await readPeerShares(peer.key, S)), ['photos'], 'precondition: the peer share reads')
  t.alike(looseNames(await collectPeerShare(peer.catalogKey, 'loose')), ['a.txt'], 'precondition: the peer catalog reads')

  const { purged } = await leave(first)
  t.is(purged, 1, 'only the catalog, whose cache the leave released, is purged')
  t.alike(shareIds(await readPeerShares(peer.key, S, scaled(3000))), ['photos'], 'the held profile core still reads')
})
