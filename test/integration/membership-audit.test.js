import test from 'brittle'
import { freshPeer } from '../helpers/store.js'
import { until } from '../helpers/bare-poll.js'
import { queryAudit } from '../../src/shared/audit/audit-query.js'
import { upsertMember } from '../../src/shared/spaces/space.js'
import { createSpace } from '../../src/shared/spaces/space-lifecycle.js'

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
