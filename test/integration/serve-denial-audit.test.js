import test from 'brittle'
import { freshPeer } from '../helpers/store.js'
import { flushAudit } from '../../src/shared/audit/audit-log.js'
import { queryAudit } from '../../src/shared/audit/audit-query.js'
import { recordServeDenial } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'
import { serveIndex } from '../../src/shared/transfer/backends/overlay/overlay-serve-index.js'
import { tagged } from '../helpers/capture-console.js'

const REQUESTER = 'ab'.repeat(32)
const hashOf = (n) => String(n).padStart(64, '0')

test('a denied serve lands as a security row naming the reason and the requester prefix', async (t) => {
  await freshPeer(t)
  await recordServeDenial('not-a-member', { from: REQUESTER, contentHash: hashOf(1) })
  await flushAudit()
  const { entries } = await queryAudit({})
  const denied = entries.find((e) => e.kind === 'security.serve_denied')
  t.ok(denied, 'the row was written')
  t.alike(denied?.subject, { reason: 'not-a-member', requester: REQUESTER.slice(0, 12) })
})

// REGRESSION (FIX-OBS-2: a throw while resolving the denial row was swallowed by an empty catch, and
// the serve-index lookups ran outside the chain, so their throw escaped into the gate's wrapper.)
test('REGRESSION (FIX-OBS-2): a denial whose lookup throws is warned, and the next attempt still records', async (t) => {
  await freshPeer(t)
  const lines = tagged(t, '[audit]', { levels: ['warn'], join: true })
  const spacesFor = serveIndex.spacesFor
  serveIndex.spacesFor = () => { throw Object.assign(new Error('index closed'), { code: 'SESSION_CLOSED' }) }
  t.teardown(() => { serveIndex.spacesFor = spacesFor })

  await recordServeDenial('not-a-member', { from: REQUESTER, contentHash: hashOf(2) })
  const line = lines.find((l) => l.includes('kind=security.serve_denied'))
  t.ok(line, 'the lost row reached warn')
  t.ok(line?.includes('reason=not-a-member') && line?.includes('requester=' + REQUESTER.slice(0, 12)), 'with its context')

  serveIndex.spacesFor = spacesFor
  await recordServeDenial('not-a-member', { from: REQUESTER, contentHash: hashOf(2) })
  await flushAudit()
  const { entries } = await queryAudit({})
  t.ok(entries.some((e) => e.kind === 'security.serve_denied'), 'the retry was not swallowed by the dedupe')
})
