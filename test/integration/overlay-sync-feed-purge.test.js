import test from 'brittle'
import b4a from 'b4a'
import { freshPeer } from '../helpers/store.js'
import { getStore, createLocalBee, overlayIndexEncryptionKey } from '../../src/shared/core/store.js'
import { purgeOverlaySyncFeed, SYNC_FEED_CORE } from '../../src/shared/transfer/backends/overlay/purge-overlay-sync-feed.js'
import { OVERLAY_NAMESPACE, OVERLAY_NAMESPACE_ENC } from '../../src/shared/transfer/backends/overlay/overlay-namespaces.js'

// The feed as a 1.11.x engine left it: named, JSON, encrypted under the overlay key in -e1.
async function seedFeed(nsName, encryptionKey = null) {
  const ns = getStore().namespace(nsName)
  const feed = ns.get({ name: SYNC_FEED_CORE, valueEncoding: 'json', ...(encryptionKey ? { encryptionKey } : {}) })
  await feed.ready()
  for (let i = 0; i < 5; i++) await feed.append({ op: 0, path: '/mir/' + String(i).repeat(64), size: 1, mtime: i })
  const dk = feed.discoveryKey
  await feed.close()
  return { ns, dk }
}

// freshPeer's boot already ran the purge on an empty store; each test starts from before it.
async function clearMarker() {
  const bee = createLocalBee('app-migrations')
  await bee.ready()
  await bee.del('overlay-sync-feed-purge-v1')
  await bee.close()
}

async function peer(t) {
  await freshPeer(t)
  await clearMarker()
}

const aliasOf = (ns) => getStore().storage.getAlias({ name: SYNC_FEED_CORE, namespace: ns.ns })

async function listedCores() {
  const out = []
  for await (const dk of getStore().list()) out.push(b4a.toString(dk, 'hex'))
  return out
}

test('the purge drops the change feed in both overlay namespaces and asks for a compaction', async (t) => {
  await peer(t)
  const enc = await seedFeed(OVERLAY_NAMESPACE_ENC, overlayIndexEncryptionKey())
  const plain = await seedFeed(OVERLAY_NAMESPACE)
  const res = await purgeOverlaySyncFeed()
  t.is(res.status, 'done')
  t.is(res.compact, true, 'bytes moved, so the stage compacts')
  t.is(res.purged, 2)
  t.absent(await aliasOf(enc.ns), 'encrypted-generation alias gone')
  t.absent(await aliasOf(plain.ns), 'plaintext-generation alias gone')
  t.absent(await getStore().storage.hasCore(enc.dk), 'encrypted core data gone')
  t.absent(await getStore().storage.hasCore(plain.dk), 'plaintext core data gone')
  const listed = await listedCores()
  t.absent(listed.includes(b4a.toString(enc.dk, 'hex')) || listed.includes(b4a.toString(plain.dk, 'hex')), 'the store lists neither feed')
})

test('a second run is a no-op, and a run without the marker finds nothing and does not throw', async (t) => {
  await peer(t)
  await seedFeed(OVERLAY_NAMESPACE_ENC, overlayIndexEncryptionKey())
  t.is((await purgeOverlaySyncFeed()).status, 'done')
  t.is((await purgeOverlaySyncFeed()).status, 'skipped', 'the marker short-circuits')
  await clearMarker()
  const again = await purgeOverlaySyncFeed()
  t.is(again.status, 'done')
  t.is(again.purged, 0)
  t.is(again.compact, false)
})

test('a store that never had a feed completes with nothing to purge', async (t) => {
  await peer(t)
  const res = await purgeOverlaySyncFeed()
  t.is(res.status, 'done')
  t.is(res.purged, 0)
})

// A 1.11.x engine, or a reverted build, reopens the feed by name: the purge must leave no alias
// pointing at deleted data, or that open fails with STORAGE_EMPTY.
test('after the purge a same-name reopen succeeds', async (t) => {
  await peer(t)
  const { ns } = await seedFeed(OVERLAY_NAMESPACE_ENC, overlayIndexEncryptionKey())
  await purgeOverlaySyncFeed()
  const reopened = ns.get({ name: SYNC_FEED_CORE, valueEncoding: 'json' })
  await t.execution(reopened.ready(), 'the reopen does not throw')
  await reopened.close()
})
