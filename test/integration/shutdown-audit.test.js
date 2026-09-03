import test from 'brittle'
import { freshPeer, freshDurable } from '../helpers/store.js'
import { serveIndex } from '../../src/shared/transfer/backends/overlay/overlay-serve-index.js'
import { onServeStart, onChunkServed } from '../../src/shared/transfer/serve-ledger.js'
import { createSpace } from '../../src/shared/spaces/space.js'
import { queryAudit } from '../../src/shared/audit/audit-log.js'
import { recordTransferOutcome } from '../../src/shared/transfer/transfer-audit.js'

const HASH = 'h'.repeat(64)
const PEER = 'p'.repeat(64)

const completed = async () => (await queryAudit({ limit: 50 })).entries.filter((e) => e.kind === 'serve.completed')

// REGRESSION (LIFECYCLE-2e: tearing the network down is what EMITS serve.completed — the overlay
// close destroys each peer, whose onclose fires the serve-end callback. All three of the audit
// bee, the ledger's open sessions and the unawaited getSpace→record write were gone before that
// ran, so a transfer interrupted by quitting recorded nothing at all.)
//
// It only ever ran on a peer with no master secret, where a space drive owns a namespaced
// corestore. In identity mode — what production always is — the drive is built over the ROOT
// corestore, so SpaceDrives._close's drive.close() closed the root out from under every tier that
// closes after it: the ledger's getSpace threw, its .catch logged at debug, and the row was lost
// on every quit. SpaceDrives._close now releases each drive's own cores instead.
test('REGRESSION (LIFECYCLE-2e): a serve still live at shutdown is recorded', async (t) => {
  const ctx = await freshPeer(t)
  const space = await createSpace('Aurora')
  serveIndex.add(HASH, space.spaceId, '__loose__', 'big.bin')

  onServeStart({ from: PEER, contentHash: HASH, total: 1024 })
  onChunkServed({ from: PEER, contentHash: HASH, bytes: 512 })
  t.is((await completed()).length, 0, 'nothing recorded while the serve is still running')

  await ctx.root.close()

  // Same M as the peer that wrote them: the audit and ledger cores are keyPair-derived from it,
  // so rebooting this storage without it would open a different, empty set.
  const after = await freshDurable(t, { storage: ctx.storage, displayName: null, masterSecret: ctx.masterSecret })
  const rows = await completed()
  t.is(rows.length, 1, 'the interrupted serve was recorded during the shutdown')
  t.is(rows[0].subject.bytes, 512, 'with the bytes actually served')
  await after.tier.close()
})

// recordTransferOutcome issues an unawaited getSpace().then(record); OverlayBackend._close drains
// those before the durable tier closes the audit bee. This asserts the OUTCOME — a burst settling at
// shutdown loses no rows — and deliberately does NOT claim to be a regression test for the drain:
// measured, it passes with the drain removed, because 100 queued spaces-bee reads still finish long
// before the durable tier goes down. The window the drain closes is the one LIFECYCLE-2e proved real
// for serve.completed, where the rows are created BY the teardown itself and the remaining time is a
// fraction of this; reproducing that for a download needs a fetch settling mid-close, which is a race
// no assertion can pin. The drain is defence in depth against a known-reachable window, not dead code.
test('a burst of transfers settling during shutdown loses no audit rows', async (t) => {
  const ctx = await freshPeer(t)
  const space = await createSpace('Aurora')
  const BURST = 100

  for (let i = 0; i < BURST; i++) {
    recordTransferOutcome({
      spaceId: space.spaceId, path: '/Brand Assets/late-' + i + '.bin', relPath: 'late-' + i + '.bin',
      shareId: 'sh1', folderName: 'Brand Assets', size: 2048, ownerPublicKey: PEER,
    }, 'ok', null)
  }
  await ctx.root.close()

  const after = await freshDurable(t, { storage: ctx.storage, displayName: null, masterSecret: ctx.masterSecret })
  const rows = (await queryAudit({ limit: 500 })).entries.filter((e) => e.kind === 'transfer.completed')
  t.is(rows.length, BURST, 'every audit write issued before the close landed')
  t.is(rows[0].subject.folder, 'Brand Assets')
  await after.tier.close()
})
