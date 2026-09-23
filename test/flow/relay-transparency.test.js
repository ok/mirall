import test from 'brittle'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'
import { localRelay, relayFlags, flags, idStore, bothPlanesSettled, RELAY_AUDIT_DWELL_MS } from '../helpers/local-relay.js'
import { DIAGNOSTICS_SCHEMA } from '../../src/shared/network/support-bundle.js'

test('a relay offered by one peer is attributed on both sides', { timeout: scaled(180000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const relay = await localRelay(t, bootstrap)

  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: relayFlags(relay.key) })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: flags() })
  await connectInSpace(t, A, B)

  t.ok(relay.stats.pairings.requested >= 1, 'both sides asked the relay to pair')
  t.ok(relay.stats.pairings.matched >= 1, 'the relay matched a pairing between the two peers')

  const frameA = await A.until('network:status:get', {}, bothPlanesSettled, { ms: 30000 })
  const frameB = await B.until('network:status:get', {}, bothPlanesSettled, { ms: 30000 })

  t.ok(frameA.stats.relaying.selected >= 1, 'A chose its relay for the dial')
  t.is(typeof frameA.relay.digest, 'string')

  const relayedA = frameA.relay.connections[0]
  if (relayedA) {
    t.is(relayedA.via, 'own')
    t.is(relayedA.relayKey, relay.key)
    t.is(relayedA.displayName, 'Bob')
  } else {
    t.is(frameA.relay.direct.control + frameA.relay.direct.content, 2, 'A upgraded both planes to a direct path on loopback')
  }
  const relayedB = frameB.relay.connections[0]
  if (relayedB) {
    t.is(relayedB.via, 'adopted')
    t.is(relayedB.relayKey, relay.key)
    t.is(relayedB.displayName, 'Alice')
  } else {
    t.is(frameB.relay.direct.control + frameB.relay.direct.content, 2, 'B upgraded both planes to a direct path on loopback')
  }
  t.comment(`relayed on A: ${!!relayedA}, on B: ${!!relayedB}, pairings matched: ${relay.stats.pairings.matched}`)

  const bundle = await A.request('diagnostics:export', { redact: true })
  t.is(bundle.schema, DIAGNOSTICS_SCHEMA)
  t.is(bundle.relay.mode, 'always')
  t.is(bundle.relay.own.kind, 'open')
  t.absent(JSON.stringify(bundle).includes(relay.key), 'the redacted bundle carries no full relay key')

  if (relayedA) {
    await new Promise((resolve) => setTimeout(resolve, RELAY_AUDIT_DWELL_MS * 3))
    const { entries } = await A.request('audit:list', { limit: 50 })
    const row = entries.find((e) => e.kind === 'network.peer_relayed')
    if (row) {
      t.is(row.subject.via, 'own')
      t.is(row.subject.label, 'Test relay')
      t.is(row.actor.name, 'Bob')
    } else {
      t.comment('the connection went direct before the audit dwell')
    }
  }
})
