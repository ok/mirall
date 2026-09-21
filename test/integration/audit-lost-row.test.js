import test from 'brittle'
import fs from 'bare-fs'
import crypto from 'hypercore-crypto'
import { openStore, setMasterSecret } from '../../src/shared/core/store.js'
import {
  initAuditLog, closeAuditLog, record, recordResolved, flushAudit, setAuditConfig, auditBee,
} from '../../src/shared/audit/audit-log.js'
import { queryAudit } from '../../src/shared/audit/audit-query.js'
import { purgeAudit } from '../../src/shared/audit/audit-reclaim.js'
import { tmpDir } from '../helpers/bare-tmp.js'
import { tagged } from '../helpers/capture-console.js'

async function boot(t) {
  const storage = tmpDir('audit-lost-row')
  t.teardown(() => { try { fs.rmSync(storage, { recursive: true, force: true }) } catch {} })
  await openStore(storage)
  setMasterSecret(crypto.randomBytes(32))
  await initAuditLog({ installId: 'install-under-test' })
  await setAuditConfig({ enabled: true, retentionDays: 90, maxEntries: 200000 })
  await purgeAudit()
}

const row = (id) => ({ actor: { type: 'self', key: null, name: null }, space: null, target: { kind: 'space', id, name: id } })
const failing = (code) => async () => { throw Object.assign(new Error('spaces bee closed'), { code }) }

// REGRESSION (FIX-OBS-2: a row whose space-name read failed was dropped at debug — or with no log
// at all for security.serve_denied — so a lost security row left no trace at the default level.)
test('REGRESSION (FIX-OBS-2): a failed resolve is warned with its context and never rejects', async (t) => {
  await boot(t)
  const lines = tagged(t, '[audit]', { levels: ['warn'], join: true })

  await recordResolved('security.serve_denied', failing('SESSION_CLOSED'),
    { context: { reason: 'not-a-member', requester: 'ab3f9c2d1e5a' } })

  t.is(lines.length, 1, 'one line')
  const line = lines[0]
  t.ok(line.includes('audit row lost'), 'says a row was lost')
  for (const part of ['stage=resolve', 'kind=security.serve_denied', 'code=SESSION_CLOSED', 'reason=not-a-member', 'requester=ab3f9c2d1e5a']) {
    t.ok(line.includes(part), part)
  }
})

test('a synchronous throw in the resolver is caught the same way', async (t) => {
  await boot(t)
  const lines = tagged(t, '[audit]', { levels: ['warn'], join: true })
  await recordResolved('transfer.completed', () => { throw new TypeError('x is null') })
  t.ok(lines.some((l) => l.includes('code=TypeError')), 'falls back to the error name as the code')
})

test('repeats of one (stage, kind, code) inside the window are counted, not logged', async (t) => {
  await boot(t)
  const lines = tagged(t, '[audit]', { levels: ['warn'], join: true })
  for (let i = 0; i < 200; i++) await recordResolved('transfer.completed', failing('SESSION_CLOSED'))
  t.is(lines.length, 1, 'two hundred lost rows, one line')

  await recordResolved('transfer.completed', failing('EIO'))
  await recordResolved('transfer.failed', failing('SESSION_CLOSED'))
  t.is(lines.length, 3, 'a new code or a new kind is a new line')
})

test('reopening the log re-arms the first report', async (t) => {
  await boot(t)
  const lines = tagged(t, '[audit]', { levels: ['warn'], join: true })
  await recordResolved('transfer.completed', failing('SESSION_CLOSED'))
  await closeAuditLog()
  await initAuditLog({ installId: 'install-under-test' })
  t.teardown(() => closeAuditLog())
  await recordResolved('transfer.completed', failing('SESSION_CLOSED'))
  t.is(lines.length, 2)
})

test('a failure while the log is closed or disabled is not a lost row', async (t) => {
  await boot(t)
  const lines = tagged(t, '[audit]', { levels: ['warn'], join: true })
  await setAuditConfig({ enabled: false })
  await recordResolved('transfer.completed', failing('SESSION_CLOSED'))
  await setAuditConfig({ enabled: true })
  await closeAuditLog()
  await recordResolved('transfer.completed', failing('SESSION_CLOSED'))
  t.is(lines.length, 0, 'nothing would have been written, so nothing is reported')
})

test('a resolved row lands, and a null resolve records nothing', async (t) => {
  await boot(t)
  await recordResolved('space.created', async () => row('kept'))
  await recordResolved('space.created', async () => null)
  await flushAudit()
  const { entries } = await queryAudit({})
  t.is(entries.length, 1)
  t.is(entries[0].target.id, 'kept')
})

test('a write-stage failure goes through the same limiter', async (t) => {
  await boot(t)
  const lines = tagged(t, '[audit]', { levels: ['warn'], join: true })
  const bee = auditBee()
  const batch = bee.batch
  bee.batch = () => { throw Object.assign(new Error('disk full'), { code: 'EIO' }) }
  t.teardown(() => { bee.batch = batch })
  for (let i = 0; i < 20; i++) record('space.created', row('s' + i))
  await flushAudit()
  t.is(lines.filter((l) => l.includes('stage=write')).length, 1, 'twenty failed writes, one line')
})
