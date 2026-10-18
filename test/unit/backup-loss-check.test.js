import test from 'brittle'
import { storeVitals, lossVerdict, lossBaselineManifest, explainedLoss, adjustBaseline, ACCEPT_AFTER_MS } from '../../src/shared/storage/backup/loss-check.js'

const v = (over = {}) => ({ spaces: 4, ownCatalogs: 4, cores: 40, profileLength: 100, ownLength: 1000, ...over })

test('vitals count the store a snapshot captured', (t) => {
  const entries = [
    { role: 'profile', length: 12 }, { role: 'own-catalog', length: 5 }, { role: 'own-catalog', length: 3 },
    { role: 'local-bee', length: 7 }, { role: 'peer', length: 999 },
  ]
  t.alike(storeVitals(entries, 2), { spaces: 2, ownCatalogs: 2, cores: 5, profileLength: 12, ownLength: 20 })
})

test('growth and small changes are not flagged', (t) => {
  t.is(lossVerdict(null, v()), null, 'the first snapshot has nothing to compare with')
  t.is(lossVerdict(v(), v({ profileLength: 120, spaces: 5 })), null)
  t.is(lossVerdict(v(), v({ spaces: 3, cores: 30, ownLength: 800 })), null)
})

test('each kind of loss is named', (t) => {
  t.alike(lossVerdict(v(), v({ profileLength: 99 })).reasons, ['profile-shrank'])
  t.alike(lossVerdict(v(), v({ spaces: 2 })).reasons, ['spaces-halved'])
  t.alike(lossVerdict(v(), v({ cores: 19 })).reasons, ['cores-halved'])
  t.alike(lossVerdict(v(), v({ ownLength: 699 })).reasons, ['own-data-shrank'])
  t.is(lossVerdict({ ...v(), ownLength: undefined, totalOwnLength: 5000 }, v({ ownLength: 10 })), null, 'a baseline from before own data was measured this way is not compared')
})

test('small stores are not flagged for ordinary changes', (t) => {
  t.is(lossVerdict(v({ spaces: 1, cores: 6 }), v({ spaces: 0, cores: 3 })), null, 'leaving a single space is not a loss signal')
})

test('the baseline is the last unflagged snapshot, until a drop has lasted a week', (t) => {
  const now = Date.UTC(2026, 9, 10)
  const unflagged = { createdAt: new Date(now - 2 * 24 * 3600 * 1000).toISOString(), vitals: v() }
  const flagged = { suspect: { reasons: ['spaces-halved'] }, vitals: v({ spaces: 2 }) }
  t.is(lossBaselineManifest(unflagged, flagged, now), unflagged, 'two days on, still compared with before the drop')
  const old = { ...unflagged, createdAt: new Date(now - ACCEPT_AFTER_MS - 1).toISOString() }
  t.is(lossBaselineManifest(old, flagged, now), flagged, 'a week on, the drop is the normal')
  t.is(lossBaselineManifest(old, { vitals: v({ cores: 41 }) }, now), old, 'an unflagged newest snapshot changes nothing')
  t.is(lossBaselineManifest(null, flagged, now), flagged)
  t.is(lossBaselineManifest(null, null, now), null, 'the first snapshot has nothing to compare with')
})

test('REGRESSION (backup loss flag): emptying the Activity Log or rewriting a local bee is not a loss', (t) => {
  const before = [
    { role: 'profile', length: 100 }, { role: 'own-catalog', length: 200 }, { role: 'intents', length: 10 },
    { role: 'local-bee', name: 'audit-log', length: 5000 }, { role: 'local-bee', name: 'spaces-meta', length: 900 },
  ]
  const purged = before.map((e) => e.name === 'audit-log' ? { ...e, length: 0 } : e)
  t.is(lossVerdict(storeVitals(before, 3), storeVitals(purged, 3)), null, 'an Activity Log purge')
  const rewritten = before.map((e) => e.name === 'spaces-meta' ? { ...e, length: 40 } : e)
  t.is(lossVerdict(storeVitals(before, 3), storeVitals(rewritten, 3)), null, 'a local bee rewritten in place')
  const lostCatalog = before.map((e) => e.role === 'own-catalog' ? { ...e, length: 20 } : e)
  t.alike(lossVerdict(storeVitals(before, 3), storeVitals(lostCatalog, 3))?.reasons, ['own-data-shrank'], 'an own catalog emptied still is')
})

const core = (dk, role, length, spaceId = null) => ({ dk: dk.padEnd(64, '0'), role, length, spaceId })
const TAKEN = Date.parse('2026-10-10T00:00:00.000Z')
const manifest = (cores, spaces) => ({ createdAt: new Date(TAKEN).toISOString(), cores, spaces, vitals: storeVitals(cores, spaces.length) })
const removed = (...ids) => new Map(ids.map((id) => [id, TAKEN + 1000]))
const snapshot = (cores, spaces) => ({ cores, spaces })

const A = { id: 'space-a', name: 'Falcon' }
const B = { id: 'space-b', name: 'Harbor' }
const C = { id: 'space-c', name: 'Orbit' }
const before = manifest([
  core('01', 'profile', 100), core('02', 'intents', 10),
  core('0a', 'own-catalog', 5000, A.id), core('0b', 'own-catalog', 300, B.id), core('0c', 'own-catalog', 200, C.id),
], [A, B, C])
const withoutA = before.cores.filter((c) => c.spaceId !== A.id)

test('REGRESSION (backup loss flag on a left space): leaving the biggest space and sweeping it is not a loss', (t) => {
  const nowVitals = storeVitals(withoutA, 2)
  t.alike(lossVerdict(before.vitals, nowVitals)?.reasons, ['own-data-shrank'], 'compared whole, the leave reads as a loss')
  const explained = explainedLoss(before, snapshot(withoutA, [B, C]), removed(A.id))
  t.alike(explained, { spaces: 1, cores: 1, ownLength: 5000 })
  t.is(lossVerdict(adjustBaseline(before.vitals, explained), nowVitals), null, 'explained, not flagged')
})

test('a removal explains only its own space', (t) => {
  const after = withoutA.map((c) => (c.spaceId === B.id ? { ...c, length: 0 } : c))
  const explained = explainedLoss(before, snapshot(after, [B, C]), removed(A.id))
  t.alike(lossVerdict(adjustBaseline(before.vitals, explained), storeVitals(after, 2))?.reasons, ['own-data-shrank'], "B's emptied catalog still flags")
})

test('the profile is never explained', (t) => {
  const after = withoutA.map((c) => (c.role === 'profile' ? { ...c, length: 90 } : c))
  const explained = explainedLoss(before, snapshot(after, [B, C]), removed(A.id))
  t.alike(lossVerdict(adjustBaseline(before.vitals, explained), storeVitals(after, 2))?.reasons, ['profile-shrank'])
})

test('no evidence, no explanation: a vanished space without a recorded removal still flags', (t) => {
  const explained = explainedLoss(before, snapshot(withoutA, [B, C]), removed())
  t.alike(explained, { spaces: 0, cores: 0, ownLength: 0 })
  t.alike(lossVerdict(adjustBaseline(before.vitals, explained), storeVitals(withoutA, 2))?.reasons, ['own-data-shrank'])
})

test('leaving half the spaces on purpose is not spaces-halved', (t) => {
  const D = { id: 'space-d', name: 'Delta' }
  const four = manifest([...before.cores, core('0d', 'own-catalog', 50, D.id)], [A, B, C, D])
  const after = four.cores.filter((c) => c.spaceId !== B.id && c.spaceId !== C.id)
  t.alike(lossVerdict(four.vitals, storeVitals(after, 2))?.reasons, ['spaces-halved'])
  t.is(lossVerdict(adjustBaseline(four.vitals, explainedLoss(four, snapshot(after, [A, D]), removed(B.id, C.id))), storeVitals(after, 2)), null)
})

test('peer cores of a left space explain cores-halved', (t) => {
  const peers = Array.from({ length: 12 }, (_, i) => core('p' + i.toString(16), 'peer', 40, A.id))
  const big = manifest([...before.cores, ...peers], [A, B, C])
  t.alike(lossVerdict(big.vitals, storeVitals(withoutA, 2))?.reasons, ['cores-halved', 'own-data-shrank'])
  t.alike(explainedLoss(big, snapshot(withoutA, [B, C]), removed(A.id)), { spaces: 1, cores: 13, ownLength: 5000 })
  t.is(lossVerdict(adjustBaseline(big.vitals, explainedLoss(big, snapshot(withoutA, [B, C]), removed(A.id))), storeVitals(withoutA, 2)), null)
})

test('a core that only got shorter counts the shortfall, not its whole length', (t) => {
  const after = before.cores.map((c) => (c.spaceId === A.id ? { ...c, length: 4000 } : c))
  t.alike(explainedLoss(before, snapshot(after, [B, C]), removed(A.id)), { spaces: 1, cores: 0, ownLength: 1000 })
})

test('a baseline without core entries or spaces explains nothing', (t) => {
  t.alike(explainedLoss({ createdAt: before.createdAt, vitals: before.vitals }, snapshot(withoutA, [B, C]), removed(A.id)), { spaces: 0, cores: 0, ownLength: 0 })
})

test('a space joined again: what predates its removal is explained, its live data is not', (t) => {
  const rejoinedA = { ...A }
  const left = removed(A.id)
  const after = withoutA.concat(core('0e', 'own-catalog', 20, A.id))
  t.alike(explainedLoss(before, snapshot(after, [rejoinedA, B, C]), left), { spaces: 0, cores: 1, ownLength: 5000 }, 'the old catalog, gone after the rejoin')

  const leftEarlier = new Map([[A.id, TAKEN - 1000]])
  const rejoined = manifest([...withoutA, core('0e', 'own-catalog', 4000, A.id), core('0f', 'own', 900, A.id)], [A, B, C])
  const swept = rejoined.cores.filter((c) => c.dk !== core('0f', 'own', 0).dk)
  t.alike(explainedLoss(rejoined, snapshot(swept, [A, B, C]), leftEarlier), { spaces: 0, cores: 1, ownLength: 900 }, 'a leftover own core nothing names is')
  const lost = rejoined.cores.filter((c) => c.dk !== core('0e', 'own-catalog', 0).dk)
  const explained = explainedLoss(rejoined, snapshot(lost, [A, B, C]), leftEarlier)
  t.alike(explained, { spaces: 0, cores: 0, ownLength: 0 }, 'the live catalog of the space joined again is not')
  t.alike(lossVerdict(adjustBaseline(rejoined.vitals, explained), storeVitals(lost, 3))?.reasons, ['own-data-shrank'])
})
