import test from 'brittle'
import { peerMembersOf, readEachPeer } from '../../src/shared/spaces/member-fanout.js'
import { getRuntimeConfig, setRuntimeConfig } from '../../src/shared/core/runtime-config.js'

const members = [{ publicKey: 'me' }, { publicKey: 'a', looseCatalogKey: 'k' }, { publicKey: 'b' }, { publicKey: null }, null]

test('peerMembersOf drops ourselves and members without a key, and admits by predicate', (t) => {
  t.alike(peerMembersOf(members, 'me').map((m) => m.publicKey), ['a', 'b'])
  t.alike(peerMembersOf(members, 'me', (m) => Boolean(m.looseCatalogKey)).map((m) => m.publicKey), ['a'])
  t.alike(peerMembersOf(undefined, 'me'), [], 'no members, no peers')
})

test('readEachPeer reads every peer at once under one interactive budget, in member order', async (t) => {
  const saved = getRuntimeConfig()
  t.teardown(() => setRuntimeConfig(saved))
  setRuntimeConfig({ ...saved, interactiveReadTimeoutMs: 321 })
  const budgets = []
  let inFlight = 0
  let peak = 0
  const out = await readEachPeer(['a', 'b', 'c'], async (peer, budget) => {
    budgets.push(budget)
    peak = Math.max(peak, ++inFlight)
    await new Promise((resolve) => setTimeout(resolve, 5))
    inFlight--
    return peer.toUpperCase()
  })
  t.alike(out, ['A', 'B', 'C'])
  t.alike(budgets, [321, 321, 321], 'every read gets the configured interactive budget')
  t.is(peak, 3, 'all at once, not in series')
  t.alike(await readEachPeer(['x'], async (p, b) => b, { budget: 7 }), [7], 'an explicit budget wins')
})
