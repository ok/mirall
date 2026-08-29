import test from 'brittle'
import { freshPeer, freshDurable } from '../helpers/store.js'
import { serveIndex } from '../../src/shared/transfer/backends/overlay/overlay-serve-index.js'
import { onServeStart, onChunkServed } from '../../src/shared/transfer/serve-ledger.js'
import { createSpace } from '../../src/shared/spaces/space.js'
import { queryAudit } from '../../src/shared/audit/audit-log.js'

const HASH = 'h'.repeat(64)
const PEER = 'p'.repeat(64)

const completed = async () => (await queryAudit({ limit: 50 })).entries.filter((e) => e.kind === 'serve.completed')

// REGRESSION (LIFECYCLE-2e: tearing the network down is what EMITS serve.completed — the overlay
// close destroys each peer, whose onclose fires the serve-end callback. All three of the audit
// bee, the ledger's open sessions and the unawaited getSpace→record write were gone before that
// ran, so a transfer interrupted by quitting recorded nothing at all.)
test('REGRESSION (LIFECYCLE-2e): a serve still live at shutdown is recorded', async (t) => {
  const ctx = await freshPeer(t)
  const space = await createSpace('Aurora')
  serveIndex.add(HASH, space.spaceId, '__loose__', 'big.bin')

  onServeStart({ from: PEER, contentHash: HASH, total: 1024 })
  onChunkServed({ from: PEER, contentHash: HASH, bytes: 512 })
  t.is((await completed()).length, 0, 'nothing recorded while the serve is still running')

  await ctx.root.close()

  const after = await freshDurable(t, { storage: ctx.storage, displayName: null })
  const rows = await completed()
  t.is(rows.length, 1, 'the interrupted serve was recorded during the shutdown')
  t.is(rows[0].subject.bytes, 512, 'with the bytes actually served')
  await after.tier.close()
})
