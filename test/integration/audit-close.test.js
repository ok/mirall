import test from 'brittle'
import { freshPeer } from '../helpers/store.js'
import { getStore } from '../../src/shared/core/store.js'
import { initAuditLog, closeAuditLog, isAuditReady, record, queryAudit } from '../../src/shared/audit/audit-log.js'

// REGRESSION (LIFECYCLE-1e: closeAuditLog had zero callers and did not close the bee — it nulled
// the handle and awaited the write chain. A Hyperbee close releases its Corestore session; the
// session count is the observable. `store.sessions` is corestore 7.x's SessionTracker, the same
// collection _close drains.)
const sessions = () => [...getStore().sessions].length

const target = (id) => ({ actor: { type: 'self', key: null, name: null }, space: null, target: { kind: 'space', id, name: id.toUpperCase() } })

test('REGRESSION (LIFECYCLE-1e): closeAuditLog closes the audit bee and stops recording', async (t) => {
  await freshPeer(t)
  const before = sessions()
  await initAuditLog({ installId: 'test' })
  t.ok(sessions() > before, 'the audit bee holds a session')
  // NOT awaited: record() is synchronous and only queues onto the write chain. The guarantee is
  // that a row admitted before the close lands anyway — the chain captures the bee it was admitted
  // against, so closing cannot drop it. Awaiting here would hide a regression behind a microtask.
  record('space.created', target('s1'))
  await closeAuditLog()
  t.absent(isAuditReady(), 'not ready after close')
  t.is(sessions(), before, 'the session was released')

  t.absent(record('space.created', target('s2')), 'record() after close reports it recorded nothing')

  await initAuditLog({ installId: 'test' })
  t.teardown(() => closeAuditLog())
  const rows = await queryAudit({ limit: 10 })
  const entries = rows.entries ?? rows
  t.is(entries.length, 1, 'the row written before the close survived; the one after was dropped')
})
