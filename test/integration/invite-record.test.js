import test from 'brittle'
import os from 'bare-os'
import fs from 'bare-fs'
import path from 'bare-path'
import { initStore } from '../../src/shared/core/store.js'
import { initProfile, setProfile } from '../../src/shared/spaces/profile.js'
import {
  markInvite, readOwnInvite, revokeInvite, listOwnInvites, sweepExpiredInvites,
} from '../../src/shared/spaces/profile.js'
import { classifyInvite } from '../../src/shared/spaces/invite-policy.js'

// Per-link invite records authored into the replicated profile bee: own-side author/read, expiry
// classification (by timestamp, not pruned on read), the sweep, and revoke. The cross-member union
// read is multi-peer and lives in the flow suite.

function tmp (label) {
  const dir = path.join(os.tmpdir(), `invite-rec-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

const S = 'spaceabc00000000'

async function bootstrap (t) {
  const root = tmp('store')
  initStore(path.join(root, 'app-storage'))
  await initProfile()
  await setProfile({ displayName: 'Self', avatar: null })
  t.teardown(() => { try { fs.rmSync(root, { recursive: true, force: true }) } catch {} })
}

test('markInvite/readOwnInvite round-trip; expiry classified, not pruned on read', async (t) => {
  await bootstrap(t)
  const id1 = 'ab'.repeat(16)
  const id2 = 'cd'.repeat(16)

  await markInvite(S, id1, { autoApprove: true, expiresAt: Date.now() + 60_000 })
  const rec1 = await readOwnInvite(S, id1)
  t.is(rec1.autoApprove, true)
  t.is(classifyInvite(rec1), 'auto')

  await markInvite(S, id2, { autoApprove: false, expiresAt: Date.now() - 1 })
  t.is(classifyInvite(await readOwnInvite(S, id2)), 'expired')
  t.ok(await readOwnInvite(S, id2), 'expired record is still present (enforced by timestamp, not deleted on read)')
})

test('sweepExpiredInvites prunes only the expired own records', async (t) => {
  await bootstrap(t)
  const idA = '11'.repeat(16)
  const idB = '22'.repeat(16)

  await markInvite(S, idA, { autoApprove: true, expiresAt: Date.now() - 1 })
  await markInvite(S, idB, { autoApprove: true, expiresAt: Date.now() + 60_000 })

  t.is(await sweepExpiredInvites(S), 1)
  t.is(await readOwnInvite(S, idA), null, 'expired pruned')
  t.ok(await readOwnInvite(S, idB), 'live kept')
})

test('listOwnInvites returns minted records; revokeInvite deletes one', async (t) => {
  await bootstrap(t)
  const id1 = '33'.repeat(16)
  await markInvite(S, id1, { autoApprove: true, expiresAt: null })

  const list = await listOwnInvites(S)
  t.is(list.length, 1)
  t.is(list[0].inviteId, id1)

  await revokeInvite(S, id1)
  t.is(await readOwnInvite(S, id1), null)
})

test('null expiry never expires', async (t) => {
  await bootstrap(t)
  const id1 = '44'.repeat(16)
  await markInvite(S, id1, { autoApprove: true, expiresAt: null })
  t.is(classifyInvite(await readOwnInvite(S, id1)), 'auto')
  t.is(await sweepExpiredInvites(S), 0)
})
