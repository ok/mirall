import test from 'brittle'
import { freshPeer } from '../helpers/store.js'
import { until } from '../helpers/bare-poll.js'
import { flushAudit, setAuditConfig } from '../../src/shared/audit/audit-log.js'
import { queryAudit } from '../../src/shared/audit/audit-query.js'
import { upsertMember } from '../../src/shared/spaces/space.js'
import { createSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { createMembership } from '../../src/worker/ipc/membership.js'
import { PEER_FRAME } from '../../src/shared/contract/peer-frames.js'

const PEER = 'b'.repeat(64)

const rowsOf = async (kind) => (await queryAudit({})).entries.filter((e) => e.kind === kind && e.target?.id === PEER)

test('a member we did not approve joining the roster is recorded once', async (t) => {
  await freshPeer(t)
  const { spaceId } = await createSpace('Arrivals')

  await upsertMember(spaceId, { publicKey: PEER, displayName: 'Ben' })
  await upsertMember(spaceId, { publicKey: PEER, displayName: 'Ben' })

  t.ok(await until(async () => (await rowsOf('member.joined')).length > 0, 5000), 'the arrival was recorded')
  const rows = await rowsOf('member.joined')
  t.is(rows.length, 1, 'once, not per roster write')
  t.is(rows[0].actor?.name, 'Ben')
})

const quiet = { debug() {}, info() {}, warn() {}, error() {} }

async function knockingPeer(t, name) {
  const { fake } = await freshPeer(t)
  const space = await createSpace(name)
  const membership = createMembership(fake.ipc, { log: quiet, dropSpaceDownloadRoot: () => {} })
  const knock = () => membership.handleMembershipControl({
    type: PEER_FRAME.MEMBERSHIP_REQUEST, spaceTopic: space.topic, profileKey: PEER, displayName: 'Ben',
  }, {})
  return { spaceId: space.spaceId, knock, ...membership }
}

const requested = () => rowsOf('membership.requested')

// REGRESSION (FIX-445: the join request was marked recorded before its row was admitted, and the
// live knock audited only a changed request, so a knock that reached us while the log could not take
// the row suppressed that row for every identical knock after it.)
test('REGRESSION (FIX-445): lost join-request row suppresses retry', async (t) => {
  const { knock } = await knockingPeer(t, 'Knocks')

  await setAuditConfig({ enabled: false })
  await knock()
  await setAuditConfig({ enabled: true })
  t.is((await requested()).length, 0, 'precondition: the knock under a disabled log recorded nothing')

  await knock()
  t.ok(await until(async () => (await requested()).length > 0, 3000), 'the next identical knock records the row')
  await knock()
  await flushAudit()
  t.is((await requested()).length, 1, 'and only once')
})
