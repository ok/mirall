import test from 'brittle'
import { freshPeer } from '../helpers/store.js'
import { until } from '../helpers/bare-poll.js'
import { flushAudit, setAuditConfig } from '../../src/shared/audit/audit-log.js'
import { queryAudit } from '../../src/shared/audit/audit-query.js'
import { getSpace, upsertMember } from '../../src/shared/spaces/space.js'
import { createSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { createMembership } from '../../src/worker/ipc/membership.js'

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

// REGRESSION (FIX-445: the join request was marked recorded before its row was admitted, so a knock
// that reached us while the log could not take the row suppressed every later knock's row until the
// request resolved.)
test('REGRESSION (FIX-445): lost join-request row suppresses retry', async (t) => {
  const { fake } = await freshPeer(t)
  const { spaceId } = await createSpace('Knocks')
  const quiet = { debug() {}, info() {}, warn() {}, error() {} }
  const { memberRegistry } = createMembership(fake.ipc, { log: quiet, dropSpaceDownloadRoot: () => {} })

  await setAuditConfig({ enabled: false })
  memberRegistry.emitJoinRequest(spaceId, { publicKey: PEER, displayName: 'Ben' })
  // A read queued behind the knock's own, so the log is re-enabled only once that knock is settled.
  await getSpace(spaceId)
  await flushAudit()
  await setAuditConfig({ enabled: true })
  t.is((await rowsOf('membership.requested')).length, 0, 'precondition: the first knock recorded nothing')

  memberRegistry.emitJoinRequest(spaceId, { publicKey: PEER, displayName: 'Ben' })
  t.ok(await until(async () => (await rowsOf('membership.requested')).length > 0, 3000), 'the next knock records the row')
  memberRegistry.emitJoinRequest(spaceId, { publicKey: PEER, displayName: 'Ben' })
  await flushAudit()
  t.is((await rowsOf('membership.requested')).length, 1, 'and only once')
})
