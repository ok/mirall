import test from 'brittle'
import b4a from 'b4a'
import idEncoding from 'hypercore-id-encoding'
import { localTestnet } from '../helpers/testnet.js'
import { setRuntimeConfig, setRelayConfig } from '../../src/shared/core/runtime-config.js'
import crypto from 'hypercore-crypto'
import { Swarm, setRelayThrough, testRelayReachable, getSwarmDht, getSwarmStatus } from '../../src/shared/transfer/swarm.js'
import { ContentSwarm, getContentSwarm } from '../../src/shared/transfer/content-swarm.js'
import { createFakeIpc } from '../helpers/fake-ipc.js'

// The relay tests exercise the swarm, not the overlay; the backend is a dep so it is stubbed.
const stubOverlayBackend = {
  attach() {},
  detach: async () => {},
  resumeForOwner() {},
  resumeForOwnerAllSpaces() {},
  revokeServesForSpace() {},
}

const KEY_A = idEncoding.encode(b4a.alloc(32, 11))
const KEY_B = idEncoding.encode(b4a.alloc(32, 12))

// Mirrors the boot root: Swarm, then ContentSwarm, then apply. The order is
// the point — getContentSwarm() is null until the second call returns.
async function bootSwarms(t, { relayMode = 'off', relay = null, relaySeedHex = null } = {}) {
  const bootstrap = await localTestnet(t)
  setRuntimeConfig({ storage: null, dhtBootstrap: bootstrap, relayMode, relay })
  const ipc = createFakeIpc().ipc
  const swarm = new Swarm('swarm', { ipc, membershipControl: async () => {}, overlayBackend: stubOverlayBackend, stalledOwners: () => [], relaySeedHex })
  const content = new ContentSwarm('content-swarm', { swarm, overlayBackend: stubOverlayBackend })
  t.teardown(async () => {
    try { await content.close() } catch {}
    try { await swarm.close() } catch {}
  })
  await swarm.ready()
  await content.ready()
  return { swarm, content, bootstrap }
}

test('a configured relay reaches BOTH swarms', async (t) => {
  await bootSwarms(t, { relayMode: 'auto', relay: { publicKey: KEY_A, enabled: true } })

  const res = setRelayThrough({ publicKey: KEY_A, enabled: true }, 'auto')
  t.is(res.applied, 1)

  const content = getContentSwarm()
  t.ok(content, 'the content swarm exists')
  // Asserting only the control swarm would pass against the ordering bug this guards.
  t.is(typeof content.relayThrough, 'function', 'the content plane carries every file byte')
})

test('selecting a relay is counted on the dialing side too', async (t) => {
  await bootSwarms(t)
  const before = getSwarmStatus().stats.relaying.selected

  setRelayThrough({ publicKey: KEY_A, enabled: true }, 'always')
  // hyperswarm calls this per outbound dial; hyperdht calls it with no args when
  // announcing. dht.stats.relaying counts only the latter, so without our own counter
  // the peer doing the relaying reports zero.
  getContentSwarm().relayThrough(false, getContentSwarm())
  getContentSwarm().relayThrough()

  t.is(getSwarmStatus().stats.relaying.selected, before + 2, 'both call shapes are counted')
})

test('every encoding of one key applies the same single relay', async (t) => {
  await bootSwarms(t)
  const hex = b4a.toString(b4a.alloc(32, 11), 'hex')
  for (const publicKey of [KEY_A, hex, hex.toUpperCase(), `pear://${KEY_A}`]) {
    t.is(setRelayThrough({ publicKey, enabled: true }, 'always').applied, 1, publicKey.slice(0, 12))
  }
})

test('applying before the content swarm exists would miss the content plane', async (t) => {
  const bootstrap = await localTestnet(t)
  setRuntimeConfig({ storage: null, dhtBootstrap: bootstrap, relayMode: 'always', relay: null })
  const soloSwarm = new Swarm('swarm', { ipc: createFakeIpc().ipc, membershipControl: async () => {}, overlayBackend: stubOverlayBackend, stalledOwners: () => [] })
  t.teardown(async () => {
    try { await soloSwarm.close() } catch {}
  })
  await soloSwarm.ready()

  t.is(getContentSwarm(), null, 'null between the two constructors — the window the boot order must clear')
  setRelayThrough({ publicKey: KEY_A, enabled: true }, 'always')

  const lateContent = new ContentSwarm('content-swarm', { swarm: soloSwarm, overlayBackend: stubOverlayBackend })
  t.teardown(async () => { try { await lateContent.close() } catch {} })
  await lateContent.ready()
  t.not(typeof getContentSwarm().relayThrough, 'function', 'a swarm constructed after the call never got it')

  setRelayThrough({ publicKey: KEY_A, enabled: true }, 'always')
  t.is(typeof getContentSwarm().relayThrough, 'function', 'applying after both constructors fixes it')
})

test('mode off and empty key lists install no relay function', async (t) => {
  await bootSwarms(t)

  setRelayThrough({ publicKey: KEY_A, enabled: true }, 'off')
  t.is(getContentSwarm().relayThrough, null, 'off is byte-identical to a build without relays')

  setRelayThrough(null, 'always')
  t.is(getContentSwarm().relayThrough, null)

  setRelayThrough({ publicKey: KEY_A, enabled: false }, 'always')
  t.is(getContentSwarm().relayThrough, null, 'a disabled relay is not a relay')
})

// The relay used to be gated on a boot-frame flag as well as the mode. The flag is gone, so a
// frame from an older main may still carry the field: it must be an ignored unknown, not a
// gate, or relaying would silently switch off against a mismatched host.
test('a stale relayEnabled field no longer gates the transport', async (t) => {
  const { bootstrap } = await bootSwarms(t)
  setRuntimeConfig({ storage: null, dhtBootstrap: bootstrap, relayEnabled: false, relayMode: 'always', relay: null })

  const res = setRelayThrough({ publicKey: KEY_A, enabled: true }, 'always')
  t.is(res.applied, 1)
  t.is(typeof getContentSwarm().relayThrough, 'function', 'the retired flag is an ignored field')
})

test('the probe no longer has a disabled verdict', async (t) => {
  await bootSwarms(t)
  const verdict = await testRelayReachable(KEY_A)
  t.not(verdict.reason, 'disabled', 'the flag-gated reason is gone from the contract')
})

// The announce path is where a one-sided setup gets rescued: the peer dialling us has no
// relay of its own and adopts ours straight from the handshake payload. Asserted on the
// function actually installed on a live swarm, not just on the pure factory.
test('the installed auto function offers our relay on the announce shape', async (t) => {
  await bootSwarms(t, { relayMode: 'auto', relay: { publicKey: KEY_A, enabled: true } })
  setRelayThrough({ publicKey: KEY_A, enabled: true }, 'auto')

  const before = getSwarmStatus().stats.relaying.selected
  const offered = getContentSwarm().relayThrough()

  t.is(offered?.length, 1, 'the announce path is handed our key')
  t.ok(b4a.equals(offered[0], b4a.alloc(32, 11)), 'and it is the configured one')
  t.is(getSwarmStatus().stats.relaying.selected, before, 'offering is not counted as a selection')
})

test('setRelayThrough survives the shutdown window', async (t) => {
  const { content } = await bootSwarms(t, { relayMode: 'auto' })
  await content.close()
  t.is(getContentSwarm(), null)
  t.execution(() => setRelayThrough({ publicKey: KEY_A, enabled: true }, 'auto'),
    'a late network:set-relay during teardown must not throw')
})

test('live re-apply needs no restart', async (t) => {
  await bootSwarms(t)

  setRelayConfig('always', { publicKey: KEY_A, enabled: true })
  setRelayThrough({ publicKey: KEY_A, enabled: true }, 'always')
  const first = getContentSwarm().relayThrough
  t.is(typeof first, 'function')

  setRelayConfig('off', null)
  setRelayThrough(null, 'off')
  t.is(getContentSwarm().relayThrough, null, 'turning relays off takes effect immediately')

  setRelayThrough({ publicKey: KEY_B, enabled: true }, 'always')
  t.is(typeof getContentSwarm().relayThrough, 'function', 'and back on again')
})

test('the probe reports a decodable-but-dead key as unreachable', async (t) => {
  await bootSwarms(t)

  const invalid = await testRelayReachable('not-a-key')
  t.is(invalid.ok, false)
  t.is(invalid.reason, 'invalid-key')

  // Nothing answers on this key on the local testnet, so the probe must resolve
  // rather than hang.
  const dead = await testRelayReachable(KEY_B)
  t.is(dead.ok, false, 'a key nobody serves is not reachable')
})

test('relay counters are surfaced and dedup-visible', async (t) => {
  await bootSwarms(t)
  const status = getSwarmStatus()
  t.alike(Object.keys(status.stats.relaying).sort(), ['aborts', 'attempts', 'selected', 'successes'])
  // hyperdht's own counters stay zero without a real relayed connection; `selected` is
  // cumulative for the process, so its value is asserted in its own test above.
  t.is(status.stats.relaying.attempts, 0)
  t.is(status.stats.relaying.successes, 0)
  t.is(status.stats.relaying.aborts, 0)
})

// hyperswarm gives no way to set dht.defaultKeyPair — its seed/keyPair options set
// swarm.keyPair only — so this asserts the explicit DHT construction actually took, and that
// the key is the one the operator's roster holds.
test('a private relay pins the DHT node identity to the ticket seed', async (t) => {
  const seedHex = '9d73b3a76df0938ff055a76e4c096c54cc245b35d4db31b582faba9dde94ae4e'
  await bootSwarms(t, {
    relaySeedHex: seedHex,
    relayMode: 'auto',
    relay: { publicKey: KEY_A, kind: 'private', enabled: true },
  })
  const expected = crypto.keyPair(b4a.from(seedHex, 'hex')).publicKey
  t.alike(getSwarmDht().defaultKeyPair.publicKey, expected, 'the key the relay firewall matches')
})

test('with no seed the node identity stays ephemeral', async (t) => {
  const first = await bootSwarms(t)
  const firstKey = b4a.from(getSwarmDht().defaultKeyPair.publicKey)
  await first.content.close()
  await first.swarm.close()

  await bootSwarms(t)
  t.absent(b4a.equals(firstKey, getSwarmDht().defaultKeyPair.publicKey),
    'a relay that admits everyone gets no durable name for us')
})

test('a pinned relay identity does not touch either peer-facing key', async (t) => {
  const { swarm } = await bootSwarms(t, {
    relaySeedHex: '9d73b3a76df0938ff055a76e4c096c54cc245b35d4db31b582faba9dde94ae4e',
    relayMode: 'auto',
    relay: { publicKey: KEY_A, kind: 'private', enabled: true },
  })
  const dht = getSwarmDht()
  t.absent(b4a.equals(swarm.dht.defaultKeyPair.publicKey, getContentSwarm().keyPair.publicKey), 'content plane')
  // Both planes share one DHT node, so one enrolment covers both roles — which is what the
  // relay's per-key session cap assumes.
  t.ok(getContentSwarm().dht === dht, 'one node, both planes')
})

test('a private relay is never offered on the announce path', async (t) => {
  // Needs a live identity: without one the slot is refused outright (see FIX-6 below), which
  // would pass this test for the wrong reason.
  await bootSwarms(t, { relaySeedHex: '9d73b3a76df0938ff055a76e4c096c54cc245b35d4db31b582faba9dde94ae4e' })
  setRelayThrough({ publicKey: KEY_A, kind: 'private', enabled: true }, 'auto')
  const fn = getContentSwarm().relayThrough
  t.is(fn(), null, 'a stranger who adopted this key could only ever be refused')
  t.is(typeof fn(true, { dht: { randomized: false } }), 'object', 'we still use it ourselves')

  setRelayThrough({ publicKey: KEY_A, kind: 'open', enabled: true }, 'auto')
  t.not(getContentSwarm().relayThrough(), null, 'an open relay is still offered')
})

// hyperswarm.destroy() destroys this.dht whether it built the node or was handed one, so
// constructing it ourselves must not leak a live node.
test('the shared DHT node still dies with the swarm', async (t) => {
  const { swarm, content } = await bootSwarms(t)
  const dht = getSwarmDht()
  await content.close()
  await swarm.close()
  t.is(dht.destroyed, true)
})

// REGRESSION (FIX-6: a config naming a private relay is not proof the seed is live — a machine
// move that copied config.json but not relay-ticket.enc, or a vault unreadable under a new
// keyring, leaves readRelaySeedHex returning null. The relay key was still installed, so every
// dial went into a firewall refusal instead of falling back to a direct connection, while the log
// still said "(private)". That is precisely the silent-never-connects failure the ticket exists
// to prevent.)
test('REGRESSION (FIX-6: a private relay with no live identity is not installed)', async (t) => {
  await bootSwarms(t, { relaySeedHex: null, relayMode: 'auto', relay: { publicKey: KEY_A, kind: 'private', enabled: true } })

  const res = setRelayThrough({ publicKey: KEY_A, kind: 'private', enabled: true }, 'auto')
  t.is(res.applied, 0)
  t.is(res.reason, 'identity-missing', 'and it says why, rather than reporting success')
  t.is(getContentSwarm().relayThrough, null, 'staying direct beats routing into a refusal')

  // An OPEN relay derives no identity, so the same boot happily installs one.
  t.is(setRelayThrough({ publicKey: KEY_A, kind: 'open', enabled: true }, 'auto').applied, 1)
})

test('a private relay IS installed once its identity is live', async (t) => {
  const seedHex = '9d73b3a76df0938ff055a76e4c096c54cc245b35d4db31b582faba9dde94ae4e'
  await bootSwarms(t, { relaySeedHex: seedHex, relayMode: 'auto', relay: { publicKey: KEY_A, kind: 'private', enabled: true } })

  const res = setRelayThrough({ publicKey: KEY_A, kind: 'private', enabled: true }, 'auto')
  t.is(res.applied, 1)
  t.is(typeof getContentSwarm().relayThrough, 'function')
})
