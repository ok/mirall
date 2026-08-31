import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import os from 'bare-os'
import fs from 'bare-fs'
import path from 'bare-path'
import { initStore, getStore, setMasterSecret } from '../../src/shared/core/store.js'
import { setRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { initSpaceKeys } from '../../src/shared/spaces/space-keys.js'
import { initProfile, setProfile, getProfileBee } from '../../src/shared/spaces/profile.js'
import {
  initSpaces, createSpace, joinSpace, getSpace, getDrive,
  recordApproval, recordJoinRequest, listJoinRequests, listPendingRequests,
} from '../../src/shared/spaces/space.js'

function tmp (label) {
  const dir = path.join(os.tmpdir(), `mgate-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

async function boot (t, label) {
  const root = tmp(label)
  const storage = path.join(root, 'app-storage')
  t.teardown(async () => {
    try { await getStore().close() } catch {}
    try { fs.rmSync(root, { recursive: true, force: true }) } catch {}
  })
  setRuntimeConfig({ storage })
  initStore(storage)
  setMasterSecret(b4a.from('44'.repeat(32), 'hex'))
  await initSpaceKeys()
  await initProfile()
  await setProfile({ displayName: 'Alice', avatar: null })
  await initSpaces()
}

test('v2 create is encrypted; v2 join is pending with no drive', async (t) => {
  await boot(t, 'create')
  const space = await createSpace('Secret')
  t.is(space.schemaVersion, 2, 'created space is v2')
  t.ok(space.sckDerivable, 'creator can re-derive the SCK')

  const topic = b4a.toString(crypto.randomBytes(32), 'hex')
  const joined = await joinSpace(topic, 'Joined', 'folder')
  t.is(joined.pending, true, 'v2 join is pending')
  t.is((await getSpace(joined.spaceId)).status, 'pending')
  t.absent(getDrive(joined.spaceId), 'no drive created while pending')
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
