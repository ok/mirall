import test from 'brittle'
import { serveIndex } from '../../src/shared/transfer/backends/overlay/overlay-serve-index.js'
import {
  ServeLedger,
  onServeStart,
  onChunkServed,
  onServeEnd,
  onServePaused,
  onServeControl,
  onServeBaseline,
  subscribeServeDetail,
  unsubscribeServeDetail,
} from '../../src/shared/transfer/serve-ledger.js'

// The sender-side download ledger: who is pulling our files and how far, with the
// two-tier emission contract — a cheap always-on summary, and a per-peer detail
// stream that fires ONLY while a row is subscribed (the dropdown is open).
async function harness (t) {
  serveIndex._reset()
  const events = []
  const ledger = new ServeLedger('serve-ledger', { ipc: { emit: (type, payload) => events.push({ type, payload }) } })
  // Registered before the await: brittle refuses a teardown added after the test has ended.
  t.teardown(async () => { await ledger.close(); serveIndex._reset() })
  await ledger.ready()
  const unwrap = (e) => { const p = { ...e.payload }; delete p.channel; return p }
  const summaries = () => events.filter((e) => e.type === 'event:awareness' && e.payload.channel === 'serving').map(unwrap)
  const details = () => events.filter((e) => e.type === 'event:awareness' && e.payload.channel === 'serving-detail').map(unwrap)
  return { events, summaries, details }
}

const SPACE = 'space1'
const HASH = 'a'.repeat(64)
const LOOSE_PATH = '/report.pdf'

test('summary fires on serve start; detail does NOT until subscribed', async (t) => {
  const { events, summaries, details } = await harness(t)
  serveIndex.add(HASH, SPACE, '__loose__', 'report.pdf')

  onServeStart({ from: 'peerA', contentHash: HASH, total: 1000 })
  t.is(summaries().length, 1, 'a summary is emitted on start')
  t.alike(summaries()[0], { spaceId: SPACE, path: LOOSE_PATH, peers: ['peerA'], bytes: 0, total: 1000, pausedKeys: [] })
  t.is(details().length, 0, 'no detail emitted while unsubscribed')

  // A mid-transfer chunk is throttled (within 750ms of the forced start) AND, crucially,
  // emits no detail because nobody is subscribed.
  events.length = 0
  onChunkServed({ from: 'peerA', contentHash: HASH, bytes: 500 })
  t.is(details().length, 0, 'still no detail while unsubscribed')
})

test('subscribe returns a snapshot and turns detail on; unsubscribe turns it off', async (t) => {
  const { events, summaries, details } = await harness(t)
  serveIndex.add(HASH, SPACE, '__loose__', 'report.pdf')
  onServeStart({ from: 'peerA', contentHash: HASH, total: 1000 })
  onChunkServed({ from: 'peerA', contentHash: HASH, bytes: 500 })

  const snap = subscribeServeDetail(SPACE, LOOSE_PATH)
  t.alike(snap, { peers: [{ peerKey: 'peerA', bytes: 500, total: 1000, paused: false }] }, 'subscribe returns the current per-peer snapshot')

  // A second peer joining is a forced emit on both tiers now that we are subscribed.
  events.length = 0
  onServeStart({ from: 'peerB', contentHash: HASH, total: 1000 })
  t.is(summaries().length, 1, 'summary updates on peer-set change')
  t.alike(summaries()[0].peers.sort(), ['peerA', 'peerB'])
  t.is(details().length, 1, 'detail now fires because the row is subscribed')
  t.is(details()[0].peers.length, 2, 'detail carries both peers')

  unsubscribeServeDetail(SPACE, LOOSE_PATH)
  events.length = 0
  onServeStart({ from: 'peerC', contentHash: HASH, total: 1000 })
  t.is(details().length, 0, 'detail stops after unsubscribe')
})

test('a resumed serve (re-start for the same peer) preserves accumulated bytes', async (t) => {
  // REGRESSION: pause→resume re-issues the content-request, so onServeStart fires
  // twice for the same peer+hash. Bytes must NOT rewind to 0 (the bar would jump
  // backward), and the resumed remainder must still reach total (not linger 30s).
  const { summaries } = await harness(t)
  serveIndex.add(HASH, SPACE, '__loose__', 'report.pdf')
  onServeStart({ from: 'peerA', contentHash: HASH, total: 1000 })
  onChunkServed({ from: 'peerA', contentHash: HASH, bytes: 600 })
  onServeStart({ from: 'peerA', contentHash: HASH, total: 1000 }) // resume
  t.is(summaries().at(-1).bytes, 600, 'accumulated bytes survive the re-start (no backward jump)')
  onChunkServed({ from: 'peerA', contentHash: HASH, bytes: 400 }) // remaining chunks
  t.alike(summaries().at(-1).peers, [], 'reaches total and clears, no 30s linger')
})

test('REGRESSION (FIX-2: empty seeder bar on resume): a have-baseline raises bytes to the downloader true completion', async (t) => {
  const { summaries } = await harness(t)
  serveIndex.add(HASH, SPACE, '__loose__', 'report.pdf')
  // Fresh serve entry on resume (prior session/entry gone): starts at 0, total = full file.
  onServeStart({ from: 'peerA', contentHash: HASH, total: 1000 })
  t.is(summaries().at(-1).bytes, 0, 'starts empty — only this session served bytes')
  onServeBaseline({ from: 'peerA', contentHash: HASH, have: 700 })
  // The baseline emit is throttled (force=false), so read the live snapshot for true bytes.
  t.is(subscribeServeDetail(SPACE, LOOSE_PATH).peers[0].bytes, 700, 'bar jumps to the true baseline, not 0')
  onChunkServed({ from: 'peerA', contentHash: HASH, bytes: 300 }) // remaining chunks
  t.alike(summaries().at(-1).peers, [], 'real served bytes reach total and clear')
})

test('baseline never rewinds an already-higher served count', async (t) => {
  await harness(t)
  serveIndex.add(HASH, SPACE, '__loose__', 'report.pdf')
  onServeStart({ from: 'peerA', contentHash: HASH, total: 1000 })
  onChunkServed({ from: 'peerA', contentHash: HASH, bytes: 800 })
  onServeBaseline({ from: 'peerA', contentHash: HASH, have: 500 }) // stale/lower
  // Read the live snapshot (the served-byte summary is throttled and the no-op
  // baseline emits nothing) to assert the entry didn't rewind.
  const snap = subscribeServeDetail(SPACE, LOOSE_PATH)
  t.is(snap.peers[0].bytes, 800, 'max() guards against a backward jump')
})

test('a baseline that arrives before serve-start is stashed and drained', async (t) => {
  await harness(t)
  serveIndex.add(HASH, SPACE, '__loose__', 'report.pdf')
  onServeBaseline({ from: 'peerA', contentHash: HASH, have: 600 }) // races ahead of prep
  onServeStart({ from: 'peerA', contentHash: HASH, total: 1000 })
  t.is(subscribeServeDetail(SPACE, LOOSE_PATH).peers[0].bytes, 600, 'pending baseline applied on serve start')
})

test('a baseline whose serve never indexes (refs===0) is discarded, not leaked', async (t) => {
  await harness(t)
  // No serveIndex.add → refsFor returns []. A stashed baseline must be dropped, not
  // linger to apply to a future unrelated serve of the same hash+peer.
  onServeBaseline({ from: 'peerA', contentHash: HASH, have: 600 }) // stashed (no hashKeys)
  onServeStart({ from: 'peerA', contentHash: HASH, total: 1000 })  // refs===0 → discards stash
  serveIndex.add(HASH, SPACE, '__loose__', 'report.pdf')
  onServeStart({ from: 'peerA', contentHash: HASH, total: 1000 })  // a later real serve
  t.is(subscribeServeDetail(SPACE, LOOSE_PATH).peers[0].bytes, 0, 'stale stash did not leak onto the new serve')
})

test('REGRESSION (self-hide): a baseline at/above total caps but does NOT drop the row', async (t) => {
  const { summaries } = await harness(t)
  serveIndex.add(HASH, SPACE, '__loose__', 'report.pdf')
  onServeStart({ from: 'peerA', contentHash: HASH, total: 1000 })
  onServeBaseline({ from: 'peerA', contentHash: HASH, have: 9999 }) // self-reported, unverified
  const snap = subscribeServeDetail(SPACE, LOOSE_PATH)
  t.is(snap.peers.length, 1, 'a self-reported have must NOT drop the row')
  t.is(snap.peers[0].bytes, 1000, 'bytes cap at total (100%)')
  onServeEnd({ from: 'peerA', contentHash: HASH })
  t.alike(summaries().at(-1).peers, [], 'only a real serve-end clears the row')
})

test('detail subscription is refcounted across two consumers', async (t) => {
  // REGRESSION: two open surfaces on one row must both keep detail flowing; the
  // first to close only decrements — detail stops only at refcount zero.
  const { events, details } = await harness(t)
  serveIndex.add(HASH, SPACE, '__loose__', 'report.pdf')
  onServeStart({ from: 'peerA', contentHash: HASH, total: 1000 })
  subscribeServeDetail(SPACE, LOOSE_PATH)
  subscribeServeDetail(SPACE, LOOSE_PATH)

  unsubscribeServeDetail(SPACE, LOOSE_PATH) // one consumer closes
  events.length = 0
  onServeStart({ from: 'peerB', contentHash: HASH, total: 1000 })
  t.is(details().length, 1, 'detail still flows while a second subscriber is open')

  unsubscribeServeDetail(SPACE, LOOSE_PATH) // the last closes
  events.length = 0
  onServeStart({ from: 'peerC', contentHash: HASH, total: 1000 })
  t.is(details().length, 0, 'detail stops only when the refcount hits zero')
})

test('a completed peer (bytes >= total) is dropped from the ledger', async (t) => {
  const { events, summaries } = await harness(t)
  serveIndex.add(HASH, SPACE, '__loose__', 'report.pdf')
  onServeStart({ from: 'peerA', contentHash: HASH, total: 1000 })
  onServeStart({ from: 'peerB', contentHash: HASH, total: 1000 })

  events.length = 0
  onChunkServed({ from: 'peerA', contentHash: HASH, bytes: 1000 })
  t.alike(summaries().at(-1).peers, ['peerB'], 'completed peerA removed, peerB remains')
})

test('serve end drops the peer; emptying the file clears the row', async (t) => {
  const { events, summaries } = await harness(t)
  serveIndex.add(HASH, SPACE, '__loose__', 'report.pdf')
  onServeStart({ from: 'peerA', contentHash: HASH, total: 1000 })

  events.length = 0
  onServeEnd({ from: 'peerA', contentHash: HASH })
  t.alike(summaries().at(-1), { spaceId: SPACE, path: LOOSE_PATH, peers: [], bytes: 0, total: 0, pausedKeys: [] }, 'last summary clears the row')
})

test('folder-share files map to a relPath (no leading slash); loose files get one', async (t) => {
  const { summaries } = await harness(t)
  serveIndex.add(HASH, SPACE, 'folderShare', 'docs/spec.txt')
  onServeStart({ from: 'peerA', contentHash: HASH, total: 10 })
  t.is(summaries()[0].path, 'docs/spec.txt', 'folder-share path is the bare relPath, not /-prefixed')
})

test('ignores serve telemetry with no requester identity', async (t) => {
  const { summaries } = await harness(t)
  serveIndex.add(HASH, SPACE, '__loose__', 'report.pdf')
  onServeStart({ from: null, contentHash: HASH, total: 1000 })
  t.is(summaries().length, 0, 'no from → no ledger entry')
})

test('REGRESSION (FIX-1): a pause marks the peer paused on summary + detail without dropping it', async (t) => {
  const { events, summaries, details } = await harness(t)
  serveIndex.add(HASH, SPACE, '__loose__', 'report.pdf')
  onServeStart({ from: 'peerA', contentHash: HASH, total: 1000 })
  onChunkServed({ from: 'peerA', contentHash: HASH, bytes: 200 })
  subscribeServeDetail(SPACE, LOOSE_PATH)

  events.length = 0
  onServePaused({ from: 'peerA', contentHash: HASH })
  t.alike(summaries().at(-1).peers, ['peerA'], 'paused peer stays in the row (not dropped)')
  t.alike(summaries().at(-1).pausedKeys, ['peerA'], 'summary marks the peer paused')
  t.alike(details().at(-1).peers, [{ peerKey: 'peerA', bytes: 200, total: 1000, paused: true }], 'detail carries the paused flag')
})

test('a resume (re-start) clears the paused flag and preserves bytes', async (t) => {
  const { summaries } = await harness(t)
  serveIndex.add(HASH, SPACE, '__loose__', 'report.pdf')
  onServeStart({ from: 'peerA', contentHash: HASH, total: 1000 })
  onChunkServed({ from: 'peerA', contentHash: HASH, bytes: 200 })
  onServePaused({ from: 'peerA', contentHash: HASH })
  t.alike(summaries().at(-1).pausedKeys, ['peerA'], 'paused before resume')

  onServeStart({ from: 'peerA', contentHash: HASH, total: 1000 }) // resume re-issues the content-request
  t.alike(summaries().at(-1).pausedKeys, [], 'resume clears the paused flag')
  t.is(summaries().at(-1).bytes, 200, 'resume preserves accumulated bytes')
})

test('a trailing chunk after a pause keeps the peer paused (drain, not resume)', async (t) => {
  // REGRESSION: in-flight chunks served AFTER the pause control must NOT un-pause the
  // row — only a resume (a fresh onServeStart) clears it. Read the live snapshot
  // directly (the chunk's own emit is throttled behind the forced pause emit).
  await harness(t)
  serveIndex.add(HASH, SPACE, '__loose__', 'report.pdf')
  onServeStart({ from: 'peerA', contentHash: HASH, total: 1000 })
  onServePaused({ from: 'peerA', contentHash: HASH })
  onChunkServed({ from: 'peerA', contentHash: HASH, bytes: 100 })
  const snap = subscribeServeDetail(SPACE, LOOSE_PATH)
  t.is(snap.peers[0].paused, true, 'a drain chunk does not un-pause; only a resume clears it')
  t.is(snap.peers[0].bytes, 100, 'the drain chunk is still counted')
})

test('onServeControl routes paused→mark and stopped→drop when the serve is live', async (t) => {
  const { summaries } = await harness(t)
  serveIndex.add(HASH, SPACE, '__loose__', 'report.pdf')
  onServeStart({ from: 'peerA', contentHash: HASH, total: 1000 })
  onServeControl({ from: 'peerA', contentHash: HASH, state: 'paused' })
  t.alike(summaries().at(-1).pausedKeys, ['peerA'], 'paused control marks the peer')
  onServeControl({ from: 'peerA', contentHash: HASH, state: 'stopped' })
  t.alike(summaries().at(-1).peers, [], 'stopped control drops the peer at once')
})

test('a pause control that races ahead of the serve is applied once it starts', async (t) => {
  const { summaries } = await harness(t)
  serveIndex.add(HASH, SPACE, '__loose__', 'report.pdf')
  onServeControl({ from: 'peerA', contentHash: HASH, state: 'paused' }) // before onServeStart populates hashKeys
  t.is(summaries().length, 0, 'an early control creates no row')
  onServeStart({ from: 'peerA', contentHash: HASH, total: 1000 })
  t.alike(summaries().at(-1).pausedKeys, ['peerA'], 'the stashed pause is applied when the serve starts')
})

test('a stop control that races ahead of the serve leaves no lingering row', async (t) => {
  const { summaries } = await harness(t)
  serveIndex.add(HASH, SPACE, '__loose__', 'report.pdf')
  onServeControl({ from: 'peerA', contentHash: HASH, state: 'stopped' })
  onServeStart({ from: 'peerA', contentHash: HASH, total: 1000 })
  t.alike(summaries().at(-1).peers, [], 'the stashed stop drops the row the instant the serve starts')
})

test('REGRESSION (FIX-2): a stop drops the peer immediately (no idle-sweep wait)', async (t) => {
  const { events, summaries } = await harness(t)
  serveIndex.add(HASH, SPACE, '__loose__', 'report.pdf')
  onServeStart({ from: 'peerA', contentHash: HASH, total: 1000 })
  onChunkServed({ from: 'peerA', contentHash: HASH, bytes: 200 })

  events.length = 0
  onServeEnd({ from: 'peerA', contentHash: HASH }) // overlay-instance maps a 'stopped' control here
  t.alike(summaries().at(-1).peers, [], 'row clears at once on stop')
})
