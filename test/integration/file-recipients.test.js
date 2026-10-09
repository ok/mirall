import test from 'brittle'
import { freshPeer, freshDurable } from '../helpers/store.js'
import { until, waitFor } from '../helpers/bare-poll.js'
import { serveIndex } from '../../src/shared/transfer/overlay/overlay-serve-index.js'
import { onServeStart, onChunkServed, onServeBaseline } from '../../src/shared/transfer/serve-ledger.js'
import { listFileRecipients, noteFileRecipient } from '../../src/shared/transfer/file-recipients.js'
import { createSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { forgetSpaceRecord } from '../../src/shared/spaces/leave-records.js'
import { queryAudit } from '../../src/shared/audit/audit-query.js'
import { closeAuditLog, flushAudit, setAuditConfig } from '../../src/shared/audit/audit-log.js'

const HASH = 'h'.repeat(64)
const NEWER = 'n'.repeat(64)
const PEER = 'p'.repeat(64)

const completed = async () => {
  await flushAudit()
  return (await queryAudit({ limit: 50 })).entries.filter((e) => e.kind === 'serve.completed')
}

async function looseFile(t) {
  const ctx = await freshPeer(t)
  const space = await createSpace('Aurora')
  serveIndex.add(HASH, space.spaceId, '__loose__', 'big.bin')
  return { ctx, spaceId: space.spaceId }
}

test('a serve that covers the whole file notes its requester and records one row', async (t) => {
  const { spaceId } = await looseFile(t)
  onServeStart({ from: PEER, contentHash: HASH, total: 1024 })
  onChunkServed({ from: PEER, contentHash: HASH, bytes: 1024 })

  await waitFor(async () => (await listFileRecipients(spaceId)).length === 1, 5000, { label: 'recipient noted' })
  const [row] = await listFileRecipients(spaceId)
  t.alike({ ...row, ts: 0 }, { shareId: '__loose__', path: '/big.bin', personKey: PEER, contentHash: HASH, ts: 0 })
  const rows = await completed()
  t.is(rows.length, 1)
  t.is(rows[0].subject.path, '/big.bin')
  t.is(rows[0].subject.bytes, 1024)

  onServeStart({ from: PEER, contentHash: HASH, total: 1024 })
  onChunkServed({ from: PEER, contentHash: HASH, bytes: 1024 })
  await new Promise((resolve) => setTimeout(resolve, 200))
  t.is((await completed()).length, 1, 'a second copy of the same version is not a second recipient')
})

test('a resumed download completes when the downloader reports holding the whole file', async (t) => {
  const { spaceId } = await looseFile(t)
  onServeStart({ from: PEER, contentHash: HASH, total: 1024 })
  onServeBaseline({ from: PEER, contentHash: HASH, have: 768 })
  onChunkServed({ from: PEER, contentHash: HASH, bytes: 256 })
  onServeBaseline({ from: PEER, contentHash: HASH, have: 1024 })
  t.ok(await until(async () => (await listFileRecipients(spaceId)).length === 1, 5000), 'the final report completes it')
})

// REGRESSION (RECIPIENT-1: the downloader's cumulative have already counts the bytes we served, and
// adding the two declared a download complete at about half way.)
test('REGRESSION (RECIPIENT-1): a progress report half way through notes nobody', async (t) => {
  const { spaceId } = await looseFile(t)
  onServeStart({ from: PEER, contentHash: HASH, total: 1024 })
  onChunkServed({ from: PEER, contentHash: HASH, bytes: 512 })
  onServeBaseline({ from: PEER, contentHash: HASH, have: 512 })
  onChunkServed({ from: PEER, contentHash: HASH, bytes: 64 })
  await new Promise((resolve) => setTimeout(resolve, 200))
  t.alike(await listFileRecipients(spaceId), [], 'still downloading')
  t.is((await completed()).length, 0)
})

// REGRESSION (RECIPIENT-2: a hash advertised in two spaces was credited to whichever came first.)
test('REGRESSION (RECIPIENT-2): bytes advertised in two spaces are credited to neither when the row is unclear', async (t) => {
  const { spaceId } = await looseFile(t)
  const other = await createSpace('Borealis')
  serveIndex.add(HASH, other.spaceId, '__loose__', 'copy.bin')
  onServeStart({ from: PEER, contentHash: HASH, total: 1024 })
  onChunkServed({ from: PEER, contentHash: HASH, bytes: 1024 })
  await new Promise((resolve) => setTimeout(resolve, 200))
  t.alike(await listFileRecipients(spaceId), [])
  t.alike(await listFileRecipients(other.spaceId), [])
  t.is((await completed()).length, 0)
})

test('a partial serve notes nobody, even when shutdown ends it', async (t) => {
  const { ctx, spaceId } = await looseFile(t)
  onServeStart({ from: PEER, contentHash: HASH, total: 1024 })
  onChunkServed({ from: PEER, contentHash: HASH, bytes: 512 })
  await ctx.root.close()

  // Same M as the peer that wrote them: the local bees are keyPair-derived from it.
  const after = await freshDurable(t, { storage: ctx.storage, displayName: null, masterSecret: ctx.masterSecret })
  t.is((await completed()).length, 0, 'an interrupted pull is not a download')
  t.alike(await listFileRecipients(spaceId), [])
  await after.tier.close()
})

test('a newer version replaces the member row, and forgetting the space clears it', async (t) => {
  const { spaceId } = await looseFile(t)
  const note = (contentHash) => noteFileRecipient({ spaceId, shareId: '__loose__', relPath: 'big.bin', contentHash, personKey: PEER, size: 1 })
  t.is(await note(HASH), true)
  t.is(await note(HASH), false, 'the same version again is not news')
  t.is(await note(NEWER), true)
  const rows = await listFileRecipients(spaceId)
  t.is(rows.length, 1)
  t.is(rows[0].contentHash, NEWER)
  t.is((await completed()).length, 2)

  await forgetSpaceRecord(spaceId)
  t.alike(await listFileRecipients(spaceId), [])
})

test('a notifiable row is pushed as activity even while recording is switched off', async (t) => {
  const { ctx, spaceId } = await looseFile(t)
  await setAuditConfig({ enabled: false })
  t.teardown(() => setAuditConfig({ enabled: true }))
  await noteFileRecipient({ spaceId, shareId: '__loose__', relPath: 'big.bin', contentHash: HASH, personKey: PEER, size: 1 })

  const pushed = ctx.fake.emitted('event:activity').map((e) => e.payload)
  t.is(pushed.length, 1)
  t.is(pushed[0].kind, 'serve.completed')
  t.is(pushed[0].actor.key, PEER)
  t.is(pushed[0].space.id, spaceId)
  t.is((await completed()).length, 0, 'and nothing is written to the log')
  t.alike(ctx.fake.emitted('event:recipients-updated').map((e) => e.payload), [{ spaceId }])
})

// REGRESSION (NOTIFY-2: the push was wired through the audit log's lifecycle, so a log that failed to
// start silenced every activity notification.)
test('REGRESSION (NOTIFY-2): activity is pushed with the audit log closed', async (t) => {
  const { ctx, spaceId } = await looseFile(t)
  await closeAuditLog()
  await noteFileRecipient({ spaceId, shareId: '__loose__', relPath: 'big.bin', contentHash: HASH, personKey: PEER, size: 1 })
  t.is(ctx.fake.emitted('event:activity').filter((e) => e.payload.kind === 'serve.completed').length, 1)
})
