import test from 'brittle'
import { snapshotDue, nextDepartures } from '../../src/shared/storage/backup/snapshot-rules.js'
import { RETENTION } from '../../src/shared/storage/backup/retention.js'

const bee = (name) => ({ role: 'local-bee', name })
const due = (over) => snapshotDue({ first: false, filesChanged: false, changed: [], gone: [], ...over })

test('bookkeeping alone writes no snapshot', (t) => {
  t.absent(due({ changed: [bee('audit-log'), bee('reclaim-meta'), bee('downloads-meta'), bee('pending-transfers'), bee('app-migrations')] }))
  t.absent(due({ gone: [bee('audit-log')] }))
  t.absent(due({}), 'nothing changed')
})

test('what a user would recognise writes one', (t) => {
  for (const entry of [
    { role: 'own-catalog' }, { role: 'peer' }, { role: 'profile' }, { role: 'intents' }, { role: 'own' },
    bee('spaces-meta'), bee('mounts-meta'),
  ]) t.ok(due({ changed: [bee('audit-log'), entry] }), entry.name ?? entry.role)
  t.ok(due({ gone: [{ role: 'peer' }] }), 'a member\'s core gone')
  t.ok(due({ filesChanged: true }), 'space keys or settings')
  t.ok(due({ first: true }), 'the first snapshot of a folder')
})

test('a space left is recorded with the snapshot from before, for a month', (t) => {
  const now = Date.UTC(2026, 9, 6)
  const previous = { name: 'p1', manifest: { spaces: [{ id: 'a', name: 'Team' }, { id: 'b', name: 'Holiday' }] } }
  const departures = nextDepartures(previous, [{ id: 'a', name: 'Team' }], now)
  t.alike(departures, [{ before: 'p1', at: new Date(now).toISOString(), spaces: ['Holiday'] }])

  const carried = nextDepartures({ name: 'p2', manifest: { spaces: [{ id: 'a', name: 'Team' }], departures } }, [{ id: 'a', name: 'Team' }], now + 1000)
  t.alike(carried, departures, 'later snapshots carry it')
  const expired = nextDepartures({ name: 'p3', manifest: { spaces: [], departures } }, [], now + RETENTION.pinFor + 1)
  t.alike(expired, [], 'a month on it is dropped')
})

test('a previous snapshot without a space list records no departure', (t) => {
  t.alike(nextDepartures({ name: 'old', manifest: {} }, [], Date.now()), [])
  t.alike(nextDepartures(null, [{ id: 'a', name: 'Team' }], Date.now()), [])
})
