import test from 'brittle'
import { freshPeer, freshDurable } from '../helpers/store.js'
import { serveIndex } from '../../src/shared/transfer/overlay/overlay-serve-index.js'
import { onServeStart, onChunkServed } from '../../src/shared/transfer/serve-ledger.js'
import { createSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { queryAudit } from '../../src/shared/audit/audit-query.js'
import { recordTransferOutcome } from '../../src/shared/audit/transfer-audit.js'
import { listFileRecipients } from '../../src/shared/transfer/file-recipients.js'

const HASH = 'h'.repeat(64)
const PEER = 'p'.repeat(64)

const completed = async () => (await queryAudit({ limit: 50 })).entries.filter((e) => e.kind === 'serve.completed')

// REGRESSION (LIFECYCLE-2e: rows created during the teardown itself were lost — the ledger's
// sessions, the unawaited reads and the audit bee were gone before they landed.) A serve that
// completes as the app quits must still note its recipient and record its row.
test('REGRESSION (LIFECYCLE-2e): a serve completing as the app quits still notes its recipient', async (t) => {
  const ctx = await freshPeer(t)
  const space = await createSpace('Aurora')
  serveIndex.add(HASH, space.spaceId, '__loose__', 'big.bin')

  onServeStart({ from: PEER, contentHash: HASH, total: 1024 })
  onChunkServed({ from: PEER, contentHash: HASH, bytes: 1024 })
  await ctx.root.close()

  // Same M as the peer that wrote them: the audit and ledger cores are keyPair-derived from it,
  // so rebooting this storage without it would open a different, empty set.
  const after = await freshDurable(t, { storage: ctx.storage, displayName: null, masterSecret: ctx.masterSecret })
  const rows = await completed()
  t.is(rows.length, 1, 'the serve completed during the shutdown was recorded')
  t.is((await listFileRecipients(space.spaceId)).length, 1, 'and its recipient noted')
  await after.tier.close()
})

// recordTransferOutcome issues a recordResolved nobody awaits; AuditLog's close drains the reads in
// flight before the bee closes. This asserts the OUTCOME — a burst settling at shutdown loses no
// rows — and deliberately does NOT claim to be a regression test for the drain: 100 queued
// spaces-bee reads finish long before the durable tier goes down. The window the drain closes is the
// one LIFECYCLE-2e above proves real, where the rows are created BY the teardown itself; reproducing
// that for a download needs a fetch settling mid-close, which is a race no assertion can pin.
test('a burst of transfers settling during shutdown loses no audit rows', async (t) => {
  const ctx = await freshPeer(t)
  const space = await createSpace('Aurora')
  const BURST = 100

  for (let i = 0; i < BURST; i++) {
    recordTransferOutcome({
      spaceId: space.spaceId, path: '/Brand Assets/late-' + i + '.bin', relPath: 'late-' + i + '.bin',
      shareId: 'sh1', folderName: 'Brand Assets', size: 2048, ownerKey: PEER,
    }, 'ok', null)
  }
  await ctx.root.close()

  const after = await freshDurable(t, { storage: ctx.storage, displayName: null, masterSecret: ctx.masterSecret })
  const rows = (await queryAudit({ limit: 500 })).entries.filter((e) => e.kind === 'transfer.completed')
  t.is(rows.length, BURST, 'every audit write issued before the close landed')
  t.is(rows[0].subject.folder, 'Brand Assets')
  await after.tier.close()
})
