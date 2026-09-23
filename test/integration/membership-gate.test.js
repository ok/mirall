import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import fs from 'bare-fs'
import path from 'bare-path'
import { openStore, getStore, setMasterSecret, ownParticipationId } from '../../src/shared/core/store.js'
import { setRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { initSpaceKeys, getContentKeyForEpoch } from '../../src/shared/spaces/space-keys.js'
import { initProfile, setProfile, getProfileBee } from '../../src/shared/spaces/profile.js'
import { initSpaces, getSpace, getSpaceContentKeyForEpoch } from '../../src/shared/spaces/space.js'
import { createSpace, joinSpace, recordApproval, materializeSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { recordJoinRequest, listJoinRequests, listPendingRequests } from '../../src/shared/spaces/join-requests.js'
import { tmpDir } from '../helpers/bare-tmp.js'

async function boot(t, label) {
  const root = tmpDir(`mgate-${label}`)
  const storage = path.join(root, 'app-storage')
  t.teardown(async () => {
    try { await getStore().close() } catch {}
    try { fs.rmSync(root, { recursive: true, force: true }) } catch {}
  })
  setRuntimeConfig({ storage })
  await openStore(storage)
  setMasterSecret(b4a.from('44'.repeat(32), 'hex'))
  await initSpaceKeys()
  await initProfile()
  await setProfile({ displayName: 'Alice', avatar: null })
  await initSpaces()
}

test('v2 create is encrypted and announced; v2 join is pending and announces nothing', async (t) => {
  await boot(t, 'create')
  const space = await createSpace('Secret')
  t.is(space.schemaVersion, 2, 'created space is v2')
  t.ok(space.sckDerivable, 'creator can re-derive the SCK')
  t.is((await getProfileBee().get('drive/' + space.spaceId))?.value, ownParticipationId(space.spaceId, space.driveSuffix), 'the creator announces its participation id')

  const topic = b4a.toString(crypto.randomBytes(32), 'hex')
  const joined = await joinSpace(topic, 'Joined', 'folder')
  t.is(joined.pending, true, 'v2 join is pending')
  t.is((await getSpace(joined.spaceId)).status, 'pending')
  t.absent(await getProfileBee().get('drive/' + joined.spaceId), 'no participation announced while pending')
})

test('recordApproval writes an authored record + an approved member, clearing the request', async (t) => {
  await boot(t, 'approve')
  const space = await createSpace('Secret')
  const joiner = b4a.toString(crypto.randomBytes(32), 'hex')

  recordJoinRequest(space.spaceId, joiner, 'Bob')
  t.is(listJoinRequests(space.spaceId).length, 1, 'request recorded')

  await recordApproval(space.spaceId, joiner)
  t.is(listJoinRequests(space.spaceId).length, 0, 'request cleared on approval')

  const after = await getSpace(space.spaceId)
  t.ok(after.members.some((m) => m.publicKey === joiner && m.status === 'approved'), 'approved member recorded')

  const rec = await getProfileBee().get('approved/' + space.spaceId + '/' + joiner)
  t.ok(rec?.value, 'authored approval record written to the profile bee')
})

// FIX-APPROVE-LAG: the worker emits the approver's banner-clear hint right after recordApproval
// (before the grant + time-bounded capture). That is only safe because the pending read-model the
// renderer re-reads (space:pending-requests → listPendingRequests) is already clean at that point.
test('FIX-APPROVE-LAG: the pending list excludes the joiner the moment recordApproval resolves', async (t) => {
  await boot(t, 'approve-readmodel')
  const space = await createSpace('Secret')
  const joiner = b4a.toString(crypto.randomBytes(32), 'hex')

  recordJoinRequest(space.spaceId, joiner, 'Bob')
  const before = new Set((await getSpace(space.spaceId)).members.map((m) => m.publicKey))
  t.ok(listPendingRequests(space.spaceId, before).some((r) => r.publicKey === joiner), 'joiner pending before approval')

  await recordApproval(space.spaceId, joiner)

  const memberKeys = new Set((await getSpace(space.spaceId)).members.map((m) => m.publicKey))
  t.is(listPendingRequests(space.spaceId, memberKeys).length, 0, 'pending list clean immediately — safe to emit the hint pre-capture')
})

test('materializeSpace stores the granted key at epoch 0 by default and stamps the record', async (t) => {
  await boot(t, 'grant-epoch0')
  const topic = b4a.toString(crypto.randomBytes(32), 'hex')
  const joined = await joinSpace(topic, 'Joined', 'folder')
  const sck = b4a.from('ab'.repeat(32), 'hex')
  await materializeSpace(joined.spaceId, sck)
  const rec = await getSpace(joined.spaceId)
  t.is(rec.status, 'approved')
  t.is(rec.epoch, 0)
  t.alike(getContentKeyForEpoch(joined.spaceId, 0), sck)
  t.is((await getProfileBee().get('drive/' + joined.spaceId))?.value, ownParticipationId(joined.spaceId, rec.driveSuffix), 'the grant announces the participation id')
})

test('a grant at a later epoch (a rotated space) is stored at that epoch', async (t) => {
  await boot(t, 'grant-epoch2')
  const topic = b4a.toString(crypto.randomBytes(32), 'hex')
  const joined = await joinSpace(topic, 'Joined', 'folder')
  const sck = b4a.from('cd'.repeat(32), 'hex')
  await materializeSpace(joined.spaceId, sck, { epoch: 2 })
  const rec = await getSpace(joined.spaceId)
  t.is(rec.status, 'approved')
  t.is(rec.epoch, 2)
  t.alike(getContentKeyForEpoch(joined.spaceId, 2), sck)
  t.alike(getSpaceContentKeyForEpoch(joined.spaceId, rec, 2), sck)
  t.is(getSpaceContentKeyForEpoch(joined.spaceId, rec, 0), null, 'no epoch-0 key and none derivable for a joined space')
  const profile = await getProfileBee().get('loosecatEpoch/' + joined.spaceId)
  t.is(profile?.value, 2, 'the loose-catalog epoch is published from the stamped record')
})
