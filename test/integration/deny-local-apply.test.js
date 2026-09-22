import test from 'brittle'
import b4a from 'b4a'
import fs from 'bare-fs'
import path from 'bare-path'
import { openStore, getStore, setMasterSecret } from '../../src/shared/core/store.js'
import { setRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { initSpaceKeys } from '../../src/shared/spaces/space-keys.js'
import { initProfile, setProfile, markOwnMembership, markRequest, markRequestDenied, markApproval, revokeApproval, ownDenialStands } from '../../src/shared/spaces/profile.js'
import { initSpaces } from '../../src/shared/spaces/space.js'
import { createSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { listJoinRequests } from '../../src/shared/spaces/join-requests.js'
import { configureMemberRegistry, openMemberView, closeAllMemberViews, isDeniedJoiner, isApprovedJoiner, applyLocalDenial, applyLocalApproval, applyLocalRevocation } from '../../src/shared/spaces/member-registry.js'
import { waitFor } from '../helpers/peer-bee.js'
import { tmpDir } from '../helpers/bare-tmp.js'

async function boot(t, label) {
  const root = tmpDir(`mir-${label}`)
  const storage = path.join(root, 'app-storage')
  t.teardown(async () => {
    closeAllMemberViews()
    try { await getStore().close() } catch {}
    try { fs.rmSync(root, { recursive: true, force: true }) } catch {}
  })
  // A fold that lags every write by this much is the window under test; nothing below waits on it.
  setRuntimeConfig({ storage, peerReadTimeoutMs: 3000, deriveDebounceMs: 5000 })
  await openStore(storage)
  setMasterSecret(b4a.from('44'.repeat(32), 'hex'))
  await initSpaceKeys()
  await initProfile()
  await setProfile({ displayName: 'Alice', avatar: null })
  await initSpaces()
  configureMemberRegistry({
    metaFor: () => null,
    isConnected: () => false,
    profileFor: async () => null,
    readmitConnected: () => {},
    emitMembersUpdated: () => {},
    emitJoinRequest: () => {},
    emitJoinRequestsUpdated: () => {},
  })
  const space = await createSpace('Gated')
  await markOwnMembership(space.spaceId)
  await openMemberView(space.spaceId)
  return space.spaceId
}

const J = 'c'.repeat(64)

test('REGRESSION (#324): a local deny is visible to the knock gate before the fold runs', async (t) => {
  const S = await boot(t, 'deny-apply')
  await markRequest(S, J, { displayName: 'Carol' })
  t.absent(isDeniedJoiner(S, J), 'not denied yet')

  const ts = await markRequestDenied(S, J)
  applyLocalDenial(S, J, ts)
  t.ok(isDeniedJoiner(S, J), 'denied the moment the tombstone is written')
  t.absent(listJoinRequests(S).some((r) => r.publicKey === J), 'no derived request lingers')
})

test('REGRESSION (#324): the own tombstone stands durably until a newer receipt supersedes it', async (t) => {
  const S = await boot(t, 'deny-durable')
  t.absent(await ownDenialStands(S, J), 'nothing recorded')
  await markRequest(S, J, { displayName: 'Carol' })
  t.absent(await ownDenialStands(S, J), 'a receipt alone is not a denial')

  await markRequestDenied(S, J)
  t.ok(await ownDenialStands(S, J), 'tombstone with no receipt behind it')

  await new Promise((r) => setTimeout(r, 5))
  await markRequest(S, J, { displayName: 'Carol' })
  t.absent(await ownDenialStands(S, J), 'a strictly newer receipt re-opens the request')
})

test('a local approval is visible to the knock gate before the fold runs', async (t) => {
  const S = await boot(t, 'approve-apply')
  await markRequest(S, J, { displayName: 'Carol' })
  t.absent(isApprovedJoiner(S, J), 'not approved yet')

  await markApproval(S, J)
  applyLocalApproval(S, J)
  t.ok(isApprovedJoiner(S, J), 'approved the moment the receipt is written')
  t.ok(await waitFor(() => isApprovedJoiner(S, J)), 'still approved once the fold confirms it')
})

test('REGRESSION (FIX-377: our own revoke is visible to the serve gate before the fold runs)', async (t) => {
  const S = await boot(t, 'revoke-apply')
  const { createAdmissionGates } = await import('../../src/shared/network/admission-gates.js')
  const gates = createAdmissionGates({ connectedPeers: new Map(), log: { debug() {}, info() {}, warn() {}, error() {} }, getIpc: () => null })
  await markApproval(S, J)
  applyLocalApproval(S, J)
  t.ok(await gates.isApprovedMember(S, J), 'served while our vouch stands')

  await revokeApproval(S, J)
  applyLocalRevocation(S, J)
  t.absent(await gates.isApprovedMember(S, J), 'not served the moment our sole vouch is withdrawn')
  t.ok(await waitFor(async () => !(await gates.isApprovedMember(S, J))), 'and the re-fold agrees')
})
