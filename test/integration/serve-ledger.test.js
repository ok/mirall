import test from 'brittle'
import { createFakeIpc } from '../helpers/fake-ipc.js'
import { serveIndex } from '../../src/shared/transfer/backends/overlay/overlay-serve-index.js'
import {
  initServeLedger, _resetServeLedger, _sweepServeLedgerNow,
  onServeStart, onServePaused, onServeControl,
  subscribeServeDetail, getServeDetail, unsubscribeServeDetail, listServeSummaries,
} from '../../src/shared/transfer/serve-ledger.js'

const HASH = 'h'.repeat(64)
const PEER = 'p'.repeat(64)
const SID = 'space1'
const PATH = '/big.bin'

// The serve ledger rides the unified awareness channel, discriminated by `channel`.
const summaries = (fake) => fake.emitted('event:awareness').filter((e) => e.payload.channel === 'serving')
const details = (fake) => fake.emitted('event:awareness').filter((e) => e.payload.channel === 'serving-detail')

// The sender-side "who is downloading" ledger is in-memory and event-fed; these tests
// drive it directly (no store, no network).
function setup (t) {
  const fake = createFakeIpc()
  serveIndex._reset()
  initServeLedger(fake.ipc)
  serveIndex.add(HASH, SID, '__loose__', 'big.bin')
  t.teardown(() => { _resetServeLedger(); serveIndex._reset() })
  return fake
}

// REGRESSION (FIX-EDA-8: the idle sweep only dropped stale entries and never re-announced a
// live row, while a paused downloader emits exactly ONE summary frame — so the renderer's
// soft-state TTL erased the paused indicator ~15s after the pause even though the worker
// ledger keeps it for PAUSED_DROP_MS).
test('REGRESSION (FIX-EDA-8): the ledger sweep re-announces a still-live paused peer', (t) => {
  const fake = setup(t)
  onServeStart({ from: PEER, contentHash: HASH, total: 1000 })
  onServePaused({ from: PEER, contentHash: HASH })
  const before = summaries(fake).length
  t.ok(before > 0, 'precondition: the pause emitted a summary')

  _sweepServeLedgerNow()

  const after = summaries(fake)
  t.ok(after.length > before, 'the sweep re-announced the live row')
  const last = after[after.length - 1].payload
  t.alike(last.peers, [PEER], 're-announced frame still carries the paused peer')
  t.alike(last.pausedKeys, [PEER], 're-announced frame still marks it paused')
  t.is(last.spaceId, SID)
  t.is(last.path, PATH)
})

test('the sweep re-announces active rows too (missed-frame recovery for the renderer TTL)', (t) => {
  const fake = setup(t)
  onServeStart({ from: PEER, contentHash: HASH, total: 1000 })
  const before = summaries(fake).length

  _sweepServeLedgerNow()

  const after = summaries(fake)
  t.ok(after.length > before, 'a live active row re-announces on the sweep')
  t.alike(after[after.length - 1].payload.pausedKeys, [], 'active row carries no paused marker')
})

// The downloader→holder contract the mirror-unmount fix relies on: a STOPPED control drops a
// previously-paused peer from the ledger at once (no waiting on the 5-min PAUSED_DROP_MS sweep),
// emitting an authoritative empty summary.
test('a STOPPED control drops a previously-paused peer from the ledger', (t) => {
  const fake = setup(t)
  onServeStart({ from: PEER, contentHash: HASH, total: 1000 })
  onServePaused({ from: PEER, contentHash: HASH })
  t.is(listServeSummaries(SID).length, 1, 'precondition: one paused row present')

  onServeControl({ from: PEER, contentHash: HASH, state: 'stopped' })

  t.is(listServeSummaries(SID).length, 0, 'STOPPED cleared the row immediately')
  const last = summaries(fake).pop().payload
  t.alike(last.peers, [], 'and emitted an authoritative empty summary')
})

test('getServeDetail reads the snapshot without touching the detailSubs refcount', (t) => {
  const fake = setup(t)
  onServeStart({ from: PEER, contentHash: HASH, total: 1000 })

  const snap = subscribeServeDetail(SID, PATH)
  t.is(snap.peers.length, 1, 'subscribe returns the current snapshot')
  onServeStart({ from: PEER, contentHash: HASH, total: 1000 })
  t.ok(details(fake).length > 0, 'positive control: detail streams while subscribed')

  const read = getServeDetail(SID, PATH)
  t.is(read.peers.length, 1, 'get returns the snapshot')

  unsubscribeServeDetail(SID, PATH)

  // Refcount back at zero after ONE unsubscribe: a forced ledger emit must not stream
  // detail frames — proving getServeDetail did not increment the count.
  const detailBefore = details(fake).length
  onServeStart({ from: PEER, contentHash: HASH, total: 1000 })
  t.is(details(fake).length, detailBefore, 'no detail frame after the single unsubscribe')
})

// REGRESSION (FIX-EDA-19: the ledger sweep re-announced summaries only; detail was refreshed by a
// renderer poll (serving:detail-get on an interval). With the poll removed, a departed peer whose
// gone-frame was lost would linger in the expanded dropdown forever — the sweep must push the
// authoritative detail snapshot for every subscribed file.)
test('REGRESSION (FIX-EDA-19): the sweep pushes authoritative detail for a subscribed file', (t) => {
  const fake = setup(t)
  subscribeServeDetail(SID, PATH)
  t.teardown(() => unsubscribeServeDetail(SID, PATH))
  onServeStart({ from: PEER, contentHash: HASH, total: 1000 })
  const before = details(fake).length

  _sweepServeLedgerNow()

  const after = details(fake)
  t.ok(after.length > before, 'the sweep pushed a detail frame')
  const last = after[after.length - 1].payload
  t.is(last.spaceId, SID)
  t.is(last.path, PATH)
  t.alike(last.peers.map((p) => p.peerKey), [PEER])
})

test('the sweep pushes an EMPTY authoritative snapshot for a subscribed file with no live peers', (t) => {
  const fake = setup(t)
  subscribeServeDetail(SID, PATH)
  t.teardown(() => unsubscribeServeDetail(SID, PATH))

  _sweepServeLedgerNow()

  const frames = details(fake)
  t.ok(frames.length > 0, 'a subscribed-but-quiet file still gets a frame')
  t.alike(frames[frames.length - 1].payload.peers, [], 'and it is authoritatively empty')
})

test('the sweep pushes no detail for unsubscribed files', (t) => {
  const fake = setup(t)
  onServeStart({ from: PEER, contentHash: HASH, total: 1000 })
  const before = details(fake).length
  _sweepServeLedgerNow()
  t.is(details(fake).length, before, 'summary-only for unsubscribed files')
})

test('two subscribers on one row survive a single unsubscribe (refcount over the keyed sub)', (t) => {
  const fake = setup(t)
  subscribeServeDetail(SID, PATH)
  subscribeServeDetail(SID, PATH)
  unsubscribeServeDetail(SID, PATH)
  t.teardown(() => unsubscribeServeDetail(SID, PATH))

  _sweepServeLedgerNow()

  t.ok(details(fake).length > 0,
    'the remaining subscriber still gets sweep-driven authoritative frames')
})

// A renderer reload never sends the unsubscribe, so a leaked sub with no download entry must
// not keep the sweep timer + frame stream alive forever — it goes dormant after the quiet
// window (kept registered for a serve-start wake, see FIX-G2) and a fresh subscribe re-arms.
test('a quiet leaked detail subscription goes dormant after the quiet window', (t) => {
  const fake = setup(t)
  subscribeServeDetail(SID, PATH)
  const t0 = 1_000_000

  _sweepServeLedgerNow(t0)
  const inWindow = details(fake).length
  t.ok(inWindow > 0, 'a quiet sub still gets authoritative frames inside the window')

  _sweepServeLedgerNow(t0 + 301_000)
  t.is(details(fake).length, inWindow, 'past the window the sub is dormant — no frame')

  _sweepServeLedgerNow(t0 + 302_000)
  t.is(details(fake).length, inWindow, 'and stays dormant')

  subscribeServeDetail(SID, PATH)
  t.teardown(() => unsubscribeServeDetail(SID, PATH))
  _sweepServeLedgerNow(t0 + 303_000)
  t.ok(details(fake).length > inWindow, 'a fresh subscription receives frames again')
})

// Eviction deleted a quiet sub outright, so a downloader arriving AFTER the quiet window
// pushed summary frames but no detail — an open dropdown stayed empty until reopened.
// Dormancy keeps the sub registered (no frames, no timer) and a new serve wakes it.
test('REGRESSION (FIX-G2: a new serve wakes a dormant subscription instead of starving it)', (t) => {
  const fake = setup(t)
  subscribeServeDetail(SID, PATH)
  t.teardown(() => unsubscribeServeDetail(SID, PATH))
  const t0 = 1_000_000
  _sweepServeLedgerNow(t0)
  _sweepServeLedgerNow(t0 + 301_000)
  const dormant = details(fake).length

  onServeStart({ from: PEER, contentHash: HASH, total: 1000 })

  const onStart = details(fake)
  t.ok(onStart.length > dormant, 'the serve start pushes a detail frame to the still-registered sub')
  t.alike(onStart[onStart.length - 1].payload.peers.map((p) => p.peerKey), [PEER],
    'the frame carries the new downloader')

  _sweepServeLedgerNow(t0 + 302_000)
  t.ok(details(fake).length > onStart.length,
    'sweep-driven authoritative frames resumed for the woken sub')
})

// Navigating into a space while peers are already downloading showed a blank indicator
// until the next 10s sweep re-announce; the hook now seeds from this snapshot on mount.
test('REGRESSION (FIX-G1: serving:summary-list returns the live serve rows for a space)', (t) => {
  setup(t)
  onServeStart({ from: PEER, contentHash: HASH, total: 1000 })
  onServePaused({ from: PEER, contentHash: HASH })

  const rows = listServeSummaries(SID)
  t.is(rows.length, 1, 'one live row for the space')
  t.alike(rows[0], { spaceId: SID, path: PATH, peers: [PEER], bytes: 0, total: 1000, pausedKeys: [PEER] })
  t.alike(listServeSummaries('elsewhere'), [], 'a space with no serves lists nothing')
})
