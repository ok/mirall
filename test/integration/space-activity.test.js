import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { freshPeer, rebootPeer } from '../helpers/store.js'
import { setupOwnedShare } from '../helpers/owned.js'
import { record, recordResolved, flushAudit, setAuditConfig } from '../../src/shared/audit/audit-log.js'
import { queryAudit } from '../../src/shared/audit/audit-query.js'
import { lastActivityOf, _spaceActivityBeeForTests } from '../../src/shared/audit/space-activity.js'
import { createSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { forgetSpaceRecord } from '../../src/shared/spaces/leave-records.js'
import { getProfile } from '../../src/shared/spaces/profile.js'
import { onFsEvent } from '../../src/shared/folders/owned-watcher.js'
import { createMembership } from '../../src/worker/ipc/membership.js'
import { PEER_FRAME } from '../../src/shared/contract/peer-frames.js'
import { slimSpaces } from '../../src/worker/space-projection.js'

const spaceRow = (spaceId) => ({ actor: { type: 'self' }, space: { id: spaceId, name: 'S' } })
// Stamps are milliseconds; one taken in the same one as the last ties and falls back to the name.
const tick = () => new Promise((resolve) => setTimeout(resolve, 2))
const order = async () => (await slimSpaces(await getProfile())).map((s) => s.spaceId)

// Two spaces, the newer one first until something happens in the older one.
// Recording is switched on at the start: the log's config is process-wide, and a fresh store does
// not reset it.
async function twoSpaces(t) {
  const peer = await freshPeer(t)
  await setAuditConfig({ enabled: true })
  const older = await createSpace('Older')
  const newer = await createSpace('Newer')
  return { peer, older: older.spaceId, newer: newer.spaceId }
}

test('a space with nothing seen yet ranks by when this device created or joined it', async (t) => {
  const { older, newer } = await twoSpaces(t)
  t.alike(await order(), [newer, older])
  const listed = await slimSpaces(await getProfile())
  for (const space of listed) t.is(space.lastActivity, Date.parse(space.created), space.name + ' falls back to created')
})

test('activity counts while the Activity Log is not recording', async (t) => {
  const { older, newer } = await twoSpaces(t)
  await setAuditConfig({ enabled: false })

  await tick()
  record('file.shared', spaceRow(older))
  t.alike(await order(), [older, newer], 'a row the log did not keep still moved the space first')

  await tick()
  await recordResolved('transfer.completed', async () => spaceRow(newer), { spaceId: newer })
  t.alike(await order(), [newer, older], 'so did a resolved row, whose resolver never ran')
})

test('connectivity, security and leaving do not make a space active', async (t) => {
  const { older, newer } = await twoSpaces(t)
  for (const kind of ['network.peer_lost', 'network.peer_back', 'security.serve_denied', 'space.left', 'transfer.failed']) {
    record(kind, spaceRow(older))
  }
  await flushAudit()
  t.is(lastActivityOf(older), null, 'nothing stamped')
  t.alike(await order(), [newer, older])
})

test('the rate budget that drops rows does not drop activity', async (t) => {
  const { older, newer } = await twoSpaces(t)
  for (let i = 0; i < 130; i++) record('peer.file_shared', spaceRow(newer))
  await tick()
  record('peer.file_shared', spaceRow(older))
  await flushAudit()
  t.alike(await order(), [older, newer])
})

const pushesOf = (peer) => peer.fake.events.filter((e) => e.type === 'event:state' && e.payload.spaces)

test('a new order is pushed to every client, once per burst', async (t) => {
  const { peer, older } = await twoSpaces(t)
  const before = pushesOf(peer).length
  await tick()
  for (let i = 0; i < 20; i++) record('file.shared', spaceRow(older))
  await new Promise((resolve) => setTimeout(resolve, 100))
  const after = pushesOf(peer)
  t.is(after.length, before + 1, 'one push for the burst')
  t.is(after.at(-1).payload.spaces[0].spaceId, older, 'the pushed list is the new order')
})

test('activity that changes neither the order nor a card that reads now is not pushed', async (t) => {
  const { peer, newer } = await twoSpaces(t)
  record('file.shared', spaceRow(newer))
  await new Promise((resolve) => setTimeout(resolve, 100))
  const before = pushesOf(peer).length
  // Past the coalescing window, so this is a fresh announcement rather than a collapsed one.
  await new Promise((resolve) => setTimeout(resolve, 2100))
  record('file.shared', spaceRow(newer))
  await new Promise((resolve) => setTimeout(resolve, 100))
  t.is(pushesOf(peer).length, before, 'the space already first, just pushed as now, is not resent')
})

test('activity survives a restart', async (t) => {
  const { peer, older, newer } = await twoSpaces(t)
  await tick()
  record('share.created', spaceRow(older))
  const stamped = lastActivityOf(older)
  await rebootPeer(t, peer)
  t.is(lastActivityOf(older), stamped, 'the close wrote it and the open read it back')
  t.alike(await order(), [older, newer])
})

test('leaving a space forgets its activity', async (t) => {
  const { older } = await twoSpaces(t)
  record('file.shared', spaceRow(older))
  t.ok(lastActivityOf(older))
  await forgetSpaceRecord(older)
  t.is(lastActivityOf(older), null)
  t.absent(await _spaceActivityBeeForTests().get('space/' + older), 'gone from the bee too')
})

test('an install updating to this seeds each space from its newest counting row, once', async (t) => {
  const { peer, older, newer } = await twoSpaces(t)
  await tick()
  record('member.joined', spaceRow(older))
  record('network.peer_lost', spaceRow(newer))
  await flushAudit()
  const row = (await queryAudit({})).entries.find((e) => e.kind === 'member.joined')
  t.ok(row, 'precondition: the log holds the row')
  // The close writes what is pending, so it goes first: rewinding before it would be undone by it.
  const settled = await rebootPeer(t, peer)
  // Rewind to an install that predates the tracker: rows in the log, nothing tracked, no seed mark.
  const bee = _spaceActivityBeeForTests()
  for (const key of ['seeded', 'space/' + older, 'space/' + newer]) await bee.del(key)
  const rebooted = await rebootPeer(t, settled)

  t.is(lastActivityOf(older), row.ts, 'seeded from the member.joined row')
  t.is(lastActivityOf(newer), null, 'a connectivity row seeds nothing')
  t.alike(await order(), [older, newer])

  await _spaceActivityBeeForTests().del('space/' + older)
  await rebootPeer(t, rebooted)
  t.is(lastActivityOf(older), null, 'the seed ran once')
})

test('a time left behind for a space that is gone is dropped at the next start', async (t) => {
  const { peer } = await twoSpaces(t)
  await _spaceActivityBeeForTests().put('space/ghost', Date.now())
  await rebootPeer(t, peer)
  t.is(lastActivityOf('ghost'), null)
  t.absent(await _spaceActivityBeeForTests().get('space/ghost'), 'deleted from the bee')
})

test('a joiner knocking again and again while recording is off moves the space once', async (t) => {
  const { peer, older, newer } = await twoSpaces(t)
  await setAuditConfig({ enabled: false })
  const membership = createMembership(peer.fake.ipc, { log: { debug() {}, info() {}, warn() {}, error() {} }, dropSpaceDownloadRoot: () => {} })
  const knock = () => membership.handleMembershipControl({
    type: PEER_FRAME.MEMBERSHIP_REQUEST, profileKey: 'b'.repeat(64), displayName: 'Ben',
  }, { spaceId: older })
  await tick()
  await knock()
  const first = lastActivityOf(older)
  t.ok(first, 'the first knock counts')
  await tick()
  await knock()
  await knock()
  t.is(lastActivityOf(older), first, 'the repeats do not')
  t.alike(await order(), [older, newer])
})

test('a change inside a shared folder makes its space active; an unchanged rescan does not', async (t) => {
  const ctx = await setupOwnedShare(t)
  await setAuditConfig({ enabled: true })
  const abs = path.join(ctx.mountPath, 'plan.txt')
  fs.writeFileSync(abs, 'v1')
  await onFsEvent(ctx.spaceId, ctx.share.id, 'add', 'plan.txt', abs)
  const published = lastActivityOf(ctx.spaceId)
  t.ok(published, 'a publish stamped the space')

  await tick()
  await onFsEvent(ctx.spaceId, ctx.share.id, 'change', 'plan.txt', abs)
  t.is(lastActivityOf(ctx.spaceId), published, 'the same bytes again stamp nothing')

  fs.rmSync(abs)
  await onFsEvent(ctx.spaceId, ctx.share.id, 'unlink', 'plan.txt', abs)
  const removed = lastActivityOf(ctx.spaceId)
  t.ok(removed > published, 'a removal stamped it again')

  await tick()
  await onFsEvent(ctx.spaceId, ctx.share.id, 'unlink', 'never-published.txt', path.join(ctx.mountPath, 'never-published.txt'))
  await onFsEvent(ctx.spaceId, ctx.share.id, 'unlink', 'plan.txt', abs)
  t.is(lastActivityOf(ctx.spaceId), removed, 'a removal of nothing published, or of what is already gone, stamps nothing')
})
