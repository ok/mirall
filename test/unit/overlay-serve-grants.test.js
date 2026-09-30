import test from 'brittle'
import { ServeGrants } from '../../src/shared/transfer/backends/overlay/engine/protocol/serve-grants.js'

const peer = () => ({ authorizedServe: new Map() })

function grantsWith({ authorize = async () => true, peers = [] } = {}) {
  const ended = []
  const grants = new ServeGrants({ authorize, onServeEnd: (info) => ended.push(info), peers: () => peers })
  return { grants, ended }
}

test('a grant from an older epoch re-asks the gate once, without the request rate limit', async (t) => {
  const asked = []
  const { grants } = grantsWith({ authorize: async (_p, from, hash, opts) => { asked.push({ from, hash, opts }); return true } })
  const p = peer()
  grants.grant(p, 'content:h1', 'alice', grants.epoch)
  t.ok(await grants.stillAuthorized(p, 'content:h1'), 'a current grant serves')
  t.is(asked.length, 0, 'without asking the gate')
  grants.bumpEpoch()
  t.ok(await grants.stillAuthorized(p, 'content:h1'), 'a stale grant re-authorizes')
  t.alike(asked, [{ from: 'alice', hash: 'h1', opts: { rateLimit: false } }], 'once, as the recorded requester, rate limit off')
  t.ok(await grants.stillAuthorized(p, 'content:h1'))
  t.is(asked.length, 1, 'and is current again afterwards')
})

test('a throw keeps a granted serve going but denies a new request', async (t) => {
  const { grants } = grantsWith({ authorize: async () => { throw new Error('bee read failed') } })
  const p = peer()
  grants.grant(p, 'content:h1', 'alice', grants.epoch)
  grants.bumpEpoch()
  t.ok(await grants.stillAuthorized(p, 'content:h1'), 're-check: a transient failure is not a deny')
  t.ok(p.authorizedServe.has('content:h1'), 'and the grant stays')
  t.is(await grants.admit(p, 'alice', 'h2'), false, 'admit: a throw denies')
})

test('admit reads the gate\'s answer by truthiness', async (t) => {
  t.is(await grantsWith({ authorize: async () => 1 }).grants.admit(peer(), null, 'h'), true)
  t.is(await grantsWith({ authorize: async () => 0 }).grants.admit(peer(), null, 'h'), false)
})

test('a definitive deny at re-check drops the grant and ends its serve', async (t) => {
  const { grants, ended } = grantsWith({ authorize: async () => false })
  const p = peer()
  grants.grant(p, 'content:h1', 'alice', grants.epoch)
  grants.bumpEpoch()
  t.absent(await grants.stillAuthorized(p, 'content:h1'))
  t.absent(p.authorizedServe.has('content:h1'), 'the grant is dropped')
  t.alike(ended, [{ path: 'content:h1', peer: p, from: 'alice' }], 'serve-end fired once')
})

test('drop removes a grant whose serve never started, without a serve-end', (t) => {
  const { grants, ended } = grantsWith()
  const p = peer()
  grants.grant(p, 'content:h1', 'alice', 0)
  grants.drop(p, 'content:h1')
  t.absent(p.authorizedServe.has('content:h1'))
  t.is(ended.length, 0)
})

test('revoke drops the grants the predicate selects, fires serve-end per grant, and returns the count', (t) => {
  const a = peer()
  const b = peer()
  const { grants, ended } = grantsWith({ peers: [a, b] })
  grants.grant(a, 'content:left', 'alice', 0)
  grants.grant(a, 'content:kept', 'alice', 0)
  grants.grant(b, 'content:left', 'bob', 0)
  const seen = []
  const revoked = grants.revoke((info) => { seen.push(info.contentHash); return info.contentHash === 'left' })
  t.is(revoked, 2)
  t.alike(ended.map((e) => e.from), ['alice', 'bob'], 'one serve-end per revoked grant')
  t.ok(a.authorizedServe.has('content:kept'), 'an unselected grant survives')
  t.ok(seen.includes('kept'), 'the predicate sees the content hash, not the synthetic path')
})

test('a throwing predicate revokes nothing', (t) => {
  const a = peer()
  const { grants } = grantsWith({ peers: [a] })
  grants.grant(a, 'content:h1', 'alice', 0)
  t.is(grants.revoke(() => { throw new Error('boom') }), 0)
  t.ok(a.authorizedServe.has('content:h1'))
})

test('endAll fires serve-end once per grant', (t) => {
  const { grants, ended } = grantsWith()
  const p = peer()
  grants.grant(p, 'content:h1', 'alice', 0)
  grants.grant(p, 'content:h2', 'alice', 0)
  grants.endAll(p)
  t.alike(ended.map((e) => e.path), ['content:h1', 'content:h2'])
})

test('fromOf reads the requester from the grant, not from anything the peer sends', (t) => {
  const { grants } = grantsWith()
  const p = peer()
  grants.grant(p, 'content:h1', 'alice', 0)
  t.alike(grants.fromOf(p, 'h1'), { synthPath: 'content:h1', from: 'alice' })
  t.alike(grants.fromOf(p, 'never-granted'), { synthPath: 'content:never-granted', from: null })
})

test('a grant revoked across the re-check await is not resurrected', async (t) => {
  const p = peer()
  const { grants } = grantsWith({ authorize: async () => { p.authorizedServe.delete('content:h1'); return true } })
  grants.grant(p, 'content:h1', 'alice', grants.epoch)
  grants.bumpEpoch()
  t.absent(await grants.stillAuthorized(p, 'content:h1'))
})
