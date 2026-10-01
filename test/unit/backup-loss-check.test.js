import test from 'brittle'
import { storeVitals, lossVerdict, lossBaseline, ACCEPT_AFTER_MS } from '../../src/shared/storage/backup/loss-check.js'

const v = (over = {}) => ({ spaces: 4, ownCatalogs: 4, cores: 40, profileLength: 100, totalOwnLength: 1000, ...over })

test('vitals count the store a snapshot captured', (t) => {
  const entries = [
    { role: 'profile', length: 12 }, { role: 'own-catalog', length: 5 }, { role: 'own-catalog', length: 3 },
    { role: 'local-bee', length: 7 }, { role: 'peer', length: 999 },
  ]
  t.alike(storeVitals(entries, 2), { spaces: 2, ownCatalogs: 2, cores: 5, profileLength: 12, totalOwnLength: 27 })
})

test('growth and small changes are not flagged', (t) => {
  t.is(lossVerdict(null, v()), null, 'the first snapshot has nothing to compare with')
  t.is(lossVerdict(v(), v({ profileLength: 120, spaces: 5 })), null)
  t.is(lossVerdict(v(), v({ spaces: 3, cores: 30, totalOwnLength: 800 })), null)
})

test('each kind of loss is named', (t) => {
  t.alike(lossVerdict(v(), v({ profileLength: 99 })).reasons, ['profile-shrank'])
  t.alike(lossVerdict(v(), v({ spaces: 2 })).reasons, ['spaces-halved'])
  t.alike(lossVerdict(v(), v({ cores: 19 })).reasons, ['cores-halved'])
  t.alike(lossVerdict(v(), v({ totalOwnLength: 699 })).reasons, ['own-data-shrank'])
})

test('small stores are not flagged for ordinary changes', (t) => {
  t.is(lossVerdict(v({ spaces: 1, cores: 6 }), v({ spaces: 0, cores: 3 })), null, 'leaving a single space is not a loss signal')
})

test('the baseline is the last unflagged snapshot, until a drop has lasted a week', (t) => {
  const now = Date.UTC(2026, 9, 10)
  const unflagged = { createdAt: new Date(now - 2 * 24 * 3600 * 1000).toISOString(), vitals: v() }
  const flagged = { suspect: { reasons: ['spaces-halved'] }, vitals: v({ spaces: 2 }) }
  t.alike(lossBaseline(unflagged, flagged, now), v(), 'two days on, still compared with before the drop')
  const old = { ...unflagged, createdAt: new Date(now - ACCEPT_AFTER_MS - 1).toISOString() }
  t.alike(lossBaseline(old, flagged, now), v({ spaces: 2 }), 'a week on, the drop is the normal')
  t.alike(lossBaseline(old, { vitals: v({ cores: 41 }) }, now), v(), 'an unflagged newest snapshot changes nothing')
  t.alike(lossBaseline(null, flagged, now), v({ spaces: 2 }))
})
