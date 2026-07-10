import test from 'brittle'
import b4a from 'b4a'
import { freshPeer } from '../helpers/store.js'
import { createSpace } from '../../src/shared/spaces/space.js'
import { createBee } from '../../src/shared/core/store.js'
import {
  publishMirror, ensureMirror, setMirrorState, tombstoneMirror, readOwnMirrors, readOwnMirror, readPeerMirrors, readPeerMirror,
} from '../../src/shared/folders/mirror-records.js'

async function peerBee (name, records = [], { cap = true } = {}) {
  const bee = createBee(name)
  await bee.ready()
  if (cap) await bee.put('caps/folder-mirrors', true)
  for (const r of records) await bee.put('mirror/' + r.spaceId + '/' + r.shareId, r)
  const key = b4a.toString(bee.core.key, 'hex')
  await bee.close()
  return key
}

test('publishMirror → readOwnMirrors returns the record; setMirrorState transitions it and reports change', async (t) => {
  await freshPeer(t)
  const { spaceId } = await createSpace('Aurora')

  await publishMirror(spaceId, 's1', { state: 'syncing' })
  let own = await readOwnMirrors(spaceId)
  t.is(own.length, 1, 'one own mirror record')
  t.is(own[0].shareId, 's1')
  t.is(own[0].state, 'syncing')
  t.absent(own[0].shareOwner, 'no dead shareOwner field stored')

  t.is(await setMirrorState(spaceId, 's1', 'synced'), true, 'a real transition reports changed=true')
  own = await readOwnMirrors(spaceId)
  t.is(own[0].state, 'synced', 'state transition applied')

  t.is(await setMirrorState(spaceId, 's1', 'synced'), false, 'a no-op transition reports changed=false')
})

test('ensureMirror creates only when absent/tombstoned, in the requested state', async (t) => {
  await freshPeer(t)
  const { spaceId } = await createSpace('Aurora')

  t.is(await ensureMirror(spaceId, 's1', { state: 'paused' }), true, 'creates when absent')
  t.is((await readOwnMirror(spaceId, 's1')).state, 'paused', 'in the requested state')
  t.is(await ensureMirror(spaceId, 's1'), false, 'no-op when a live record already exists')
  t.is((await readOwnMirror(spaceId, 's1')).state, 'paused', 'ensureMirror did not overwrite the existing state')
})

test('tombstoneMirror hides the record and reports change; re-publish resurrects it', async (t) => {
  await freshPeer(t)
  const { spaceId } = await createSpace('Aurora')
  await publishMirror(spaceId, 's1', { state: 'synced' })

  t.is(await tombstoneMirror(spaceId, 's1'), true, 'first tombstone reports changed')
  t.is((await readOwnMirrors(spaceId)).length, 0, 'tombstoned record omitted from readOwnMirrors')
  t.is(await readOwnMirror(spaceId, 's1'), null, 'point read also omits a tombstone')

  await publishMirror(spaceId, 's1', { state: 'syncing' })
  const own = await readOwnMirrors(spaceId)
  t.is(own.length, 1, 're-mount resurrects the record')
  t.absent(own[0].unmirroredAt, 'no tombstone after re-publish')
})

test('REGRESSION: concurrent tombstone + state write does not resurrect the tombstone (serialized RMW)', async (t) => {
  await freshPeer(t)
  const { spaceId } = await createSpace('Aurora')
  await publishMirror(spaceId, 's1', { state: 'syncing' })

  // Fire an unmount tombstone and a trailing tick's state write together: the per-key write chain
  // must apply them atomically so the state write can't land a copy of the pre-tombstone value.
  await Promise.all([tombstoneMirror(spaceId, 's1'), setMirrorState(spaceId, 's1', 'synced')])

  t.is((await readOwnMirrors(spaceId)).length, 0, 'record stays tombstoned, not resurrected as a live "synced" ghost')
})

test('setMirrorState / tombstoneMirror no-op on a missing or already-tombstoned record', async (t) => {
  await freshPeer(t)
  const { spaceId } = await createSpace('Aurora')
  t.is(await setMirrorState(spaceId, 'ghost', 'paused'), false, 'setMirrorState on a missing record → false')
  t.is((await readOwnMirrors(spaceId)).length, 0, 'setMirrorState creates nothing')

  await publishMirror(spaceId, 's1', { state: 'synced' })
  await tombstoneMirror(spaceId, 's1')
  t.is(await tombstoneMirror(spaceId, 's1'), false, 'a second tombstone is a no-op')
  t.is(await setMirrorState(spaceId, 's1', 'synced'), false, 'setMirrorState does not revive a tombstone')
  t.is((await readOwnMirrors(spaceId)).length, 0, 'still tombstoned')
})

test('readPeerMirrors / readPeerMirror are cap-gated: a bee without caps/folder-mirrors reads as unknown (null)', async (t) => {
  await freshPeer(t)
  const { spaceId } = await createSpace('Aurora')
  const rec = { shareId: 's1', state: 'synced', mountedAt: Date.now(), ts: Date.now() }

  const noCapKey = await peerBee('peer-nocap', [{ ...rec, spaceId }], { cap: false })
  t.is(await readPeerMirrors(noCapKey, spaceId), null, 'no cap → null (unknown), never a false "none"')
  t.is(await readPeerMirror(noCapKey, spaceId, 's1'), null, 'point read is cap-gated too')

  const withCapKey = await peerBee('peer-withcap', [{ ...rec, spaceId, state: 'paused' }])
  const recs = await readPeerMirrors(withCapKey, spaceId)
  t.is(recs.length, 1, 'capped bee yields its records')
  t.is(recs[0].state, 'paused')
  t.is((await readPeerMirror(withCapKey, spaceId, 's1')).state, 'paused', 'point read returns the one share')
})

test('readPeerMirrors / readPeerMirror exclude tombstoned records', async (t) => {
  await freshPeer(t)
  const { spaceId } = await createSpace('Aurora')
  const key = await peerBee('peer-tomb', [
    { shareId: 'live', spaceId, state: 'syncing', mountedAt: Date.now(), ts: Date.now() },
    { shareId: 'dead', spaceId, state: 'synced', mountedAt: Date.now(), ts: Date.now(), unmirroredAt: Date.now() },
  ])
  t.alike((await readPeerMirrors(key, spaceId)).map((r) => r.shareId), ['live'], 'range read excludes tombstone')
  t.is(await readPeerMirror(key, spaceId, 'dead'), null, 'point read excludes tombstone')
})
