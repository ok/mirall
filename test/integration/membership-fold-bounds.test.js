import test from 'brittle'
import { freshPeerWithIdentity } from '../helpers/store.js'
import { getRuntimeConfig, setRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import {
  getLocalPublicKeyHex, markOwnMembership, markApproval, markRequest, readMembershipRecord, readPeerRequests,
} from '../../src/shared/spaces/profile.js'

// Shrink a cap for one test, then restore the full config (storage/identity included) so
// later tests in the file are unaffected. setRuntimeConfig rebuilds from `next`, so we
// spread the live config rather than passing only the patch.
function withConfig (t, patch) {
  const prev = { ...getRuntimeConfig() }
  setRuntimeConfig({ ...prev, ...patch })
  t.teardown(() => setRuntimeConfig(prev))
}

test('REGRESSION (MIR-29): approved/* read stream is clamped to maxApprovalsPerMember', async (t) => {
  await freshPeerWithIdentity(t)
  withConfig(t, { maxApprovalsPerMember: 4 })
  const me = getLocalPublicKeyHex()
  const S = 'space-approval-bounds'

  await markOwnMembership(S)
  for (let i = 0; i < 20; i++) await markApproval(S, 'joiner-' + String(i).padStart(3, '0'))

  const rec = await readMembershipRecord(me, S)
  t.is(rec.active, true, 'own membership still read')
  t.is(rec.approvals.length, 4, 'read clamped to the cap, not the 20 authored records')
})

test('REGRESSION (MIR-29): request/* read stream is clamped to maxRequestsPerMember', async (t) => {
  await freshPeerWithIdentity(t)
  withConfig(t, { maxRequestsPerMember: 3 })
  const me = getLocalPublicKeyHex()
  const S = 'space-request-bounds'

  await markOwnMembership(S)
  for (let i = 0; i < 15; i++) await markRequest(S, 'req-' + String(i).padStart(3, '0'), { displayName: 'R' + i })

  const reqs = await readPeerRequests(me, S)
  t.is(reqs.length, 3, 'request stream clamped to the cap, not the 15 authored records')
})

test('a 0 cap disables the bound (escape hatch)', async (t) => {
  await freshPeerWithIdentity(t)
  withConfig(t, { maxApprovalsPerMember: 0 })
  const me = getLocalPublicKeyHex()
  const S = 'space-uncapped'

  await markOwnMembership(S)
  for (let i = 0; i < 10; i++) await markApproval(S, 'j-' + String(i).padStart(3, '0'))

  const rec = await readMembershipRecord(me, S)
  t.is(rec.approvals.length, 10, 'cap 0 reads every authored approval')
})
