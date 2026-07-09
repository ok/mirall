import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import b4a from 'b4a'
import { freshPeer } from '../helpers/store.js'
import { createSpace, updateMembers } from '../../src/shared/spaces/space.js'
import { publishShare, tombstoneShare, generateShareId, readPeerShareEntry } from '../../src/shared/shares/shares.js'
import { listSharesForSpace } from '../../src/shared/shares/share-registry.js'
import { getLocalPublicKeyHex } from '../../src/shared/spaces/profile.js'
import { getStore, createBee } from '../../src/shared/core/store.js'
import { setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { mountRootAvailable } from '../../src/shared/folders/owned-folders.js'

function share (name) {
  return { id: generateShareId(), type: 'owned-folder', name, owner: getLocalPublicKeyHex(), createdAt: Date.now() }
}

test('listSharesForSpace returns own live shares, tagged, and omits tombstones', async (t) => {
  await freshPeer(t)
  const { spaceId } = await createSpace('Aurora')
  const keep = share('Keep')
  const drop = share('Drop')
  await publishShare(spaceId, keep)
  await publishShare(spaceId, drop)

  let listed = await listSharesForSpace(spaceId)
  t.alike(listed.map((s) => s.name).sort(), ['Drop', 'Keep'], 'both live shares listed')
  const me = getLocalPublicKeyHex()
  t.ok(listed.every((s) => s.owner === me && s.source === 'own'), 'own shares tagged owner=me, source=own')

  await tombstoneShare(spaceId, drop.id)
  listed = await listSharesForSpace(spaceId)
  t.alike(listed.map((s) => s.name), ['Keep'], 'tombstoned share is omitted')
})

// REGRESSION (FIX-20: unbounded peer-bee reads hang share:list). A member whose
// profile bee advertises shares it never replicates to us — the owner handshook
// once (so they're persisted in members) then went offline — must not stall the
// listing. readPeerShares used to await bee.get / createReadStream with no
// deadline, so listSharesForSpace fanned out into a forever-pending read; the
// renderer surfaced it as "IPC timeout: share:list (30000ms)". The bounded read
// now skips the unreachable member and returns our own shares promptly — and
// share:list reads under the SHORT interactiveReadTimeoutMs, NOT peerReadTimeoutMs:
// the large peerReadTimeoutMs below proves the interactive budget is what bounds it
// (a revert to the peer budget would block ~30s and trip the test timeout).
test('REGRESSION (FIX-20): listSharesForSpace skips an unreachable member instead of hanging', { timeout: 15000 }, async (t) => {
  await freshPeer(t)
  // Shrink the INTERACTIVE budget (the one that governs share:list) to ~300ms, and pin
  // peerReadTimeoutMs high so a regression that reverts to it can't pass on timing.
  setRuntimeConfig({ ...getRuntimeConfig(), peerReadTimeoutMs: 30000, interactiveReadTimeoutMs: 300 })

  const { spaceId } = await createSpace('Aurora')
  await publishShare(spaceId, share('Mine'))

  // Manufacture an offline member: a profile bee that knows its own length but
  // whose blocks aren't replicated locally and have no serving peer, so any
  // wait:true read parks forever. createBee gives a writable core; clearing its
  // blocks reproduces the "length known, data missing" replication state.
  const ghost = createBee('ghost-peer')
  await ghost.ready()
  await ghost.put('caps/folder-shares', true)
  await ghost.put('share/' + spaceId + '/x1', { id: 'x1', name: 'GhostShare', owner: 'ghost', createdAt: Date.now() })
  const ghostKey = b4a.toString(ghost.core.key, 'hex')
  const len = ghost.core.length
  await ghost.close()
  const ghostCore = getStore().get(b4a.from(ghostKey, 'hex'))
  await ghostCore.ready()
  await ghostCore.clear(0, len)

  await updateMembers(spaceId, [{ publicKey: ghostKey, driveKey: null, displayName: 'Ghost' }])

  const t0 = Date.now()
  const listed = await listSharesForSpace(spaceId)
  const dt = Date.now() - t0
  t.ok(dt < 4000, 'resolves within the bounded read budget (' + dt + 'ms), not the 30s IPC timeout')
  t.alike(listed.map((s) => s.name), ['Mine'], 'own share returned; unreachable member skipped')
})

test('listSharesForSpace returns [] for an unknown space', async (t) => {
  await freshPeer(t)
  t.alike(await listSharesForSpace('does-not-exist'), [], 'unknown space → empty list')
})

// REGRESSION (FIX-1): a leaver retires its shares (deletedAt). On a rejoin the leaver is a member
// again (creator-root, or after re-approval), so share-registry queries its profile bee — which
// must omit the tombstoned advertisement, keeping the previously-mirrored folder hidden. This is
// the single-peer half of the leave→rejoin flow: a current member whose share carries deletedAt.
test('REGRESSION (FIX-1): a member\'s tombstoned share is omitted from the listing', async (t) => {
  await freshPeer(t)
  const { spaceId } = await createSpace('Aurora')

  const peer = createBee('peer-rejoined')
  await peer.ready()
  await peer.put('caps/folder-shares', true)
  await peer.put('share/' + spaceId + '/s1',
    { id: 's1', name: 'Docs', owner: 'peer', createdAt: Date.now(), deletedAt: Date.now() })
  const peerKey = b4a.toString(peer.core.key, 'hex')
  await peer.close()

  await updateMembers(spaceId, [{ publicKey: peerKey, driveKey: null, displayName: 'Peer' }])

  const listed = await listSharesForSpace(spaceId)
  t.absent(listed.some((s) => s.name === 'Docs'), 'tombstoned peer share omitted even though the peer is a member')
})

// readPeerShareEntry must distinguish three states a mirror has to act on
// differently: a live share (keep mirroring), a tombstone — owner deleted it
// (tear the mirror down), and an absent entry — not replicated yet (keep
// waiting). Conflating tombstone with absent risks either a premature wipe or a
// mirror that never cleans up.
test('readPeerShareEntry distinguishes live / tombstoned / absent shares', async (t) => {
  await freshPeer(t)
  const { spaceId } = await createSpace('Aurora')
  const me = getLocalPublicKeyHex()
  const s = share('Notes')
  await publishShare(spaceId, s)

  const live = await readPeerShareEntry(me, spaceId, s.id)
  t.ok(live && !live.deletedAt, 'live share returned without deletedAt')

  await tombstoneShare(spaceId, s.id)
  const dead = await readPeerShareEntry(me, spaceId, s.id)
  t.ok(dead && dead.deletedAt, 'tombstoned share returned WITH deletedAt (owner deleted it)')

  t.is(await readPeerShareEntry(me, spaceId, 'never-existed'), null, 'absent share → null (not replicated)')
})

test('mountRootAvailable reflects whether the path is an existing directory', async (t) => {
  const { tmpDir } = await freshPeer(t)
  const dir = tmpDir('root')
  t.ok(mountRootAvailable(dir), 'existing dir → available')

  const file = path.join(dir, 'a-file')
  fs.writeFileSync(file, 'x')
  t.absent(mountRootAvailable(file), 'a file is not a mount root')

  fs.rmSync(dir, { recursive: true, force: true })
  t.absent(mountRootAvailable(dir), 'missing dir → unavailable')
})
