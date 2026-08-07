import test from 'brittle'
import b4a from 'b4a'
import idEncoding from 'hypercore-id-encoding'
import { localTestnet } from '../helpers/testnet.js'
import { setRuntimeConfig, setRelayConfig } from '../../src/shared/core/runtime-config.js'
import { initSwarm, destroySwarm, setRelayThrough, testRelayReachable, getSwarmDht, getSwarmStatus } from '../../src/shared/transfer/swarm.js'
import { initContentSwarm, destroyContentSwarm, getContentSwarm } from '../../src/shared/transfer/content-swarm.js'
import { MAX_APPLIED_RELAYS } from '../../src/shared/transfer/relay.js'
import { createFakeIpc } from '../helpers/fake-ipc.js'

const KEY_A = idEncoding.encode(b4a.alloc(32, 11))
const KEY_B = idEncoding.encode(b4a.alloc(32, 12))

// Mirrors worker/main.js: initSwarm, then initContentSwarm, then apply. The order is
// the point — getContentSwarm() is null until the second call returns.
async function bootSwarms (t, { relayEnabled = true, relayMode = 'off', relays = [] } = {}) {
  const bootstrap = await localTestnet(t)
  setRuntimeConfig({ storage: null, dhtBootstrap: bootstrap, relayEnabled, relayMode, relays })
  const ipc = createFakeIpc().ipc
  initSwarm(ipc)
  initContentSwarm(getSwarmDht())
  t.teardown(async () => {
    try { await destroyContentSwarm() } catch {}
    try { await destroySwarm() } catch {}
  })
}

test('a configured relay reaches BOTH swarms', async (t) => {
  await bootSwarms(t, { relayMode: 'auto', relays: [{ id: 'a', publicKey: KEY_A, enabled: true }] })

  const res = setRelayThrough([{ id: 'a', publicKey: KEY_A, enabled: true }], 'auto')
  t.is(res.applied, 1)

  const content = getContentSwarm()
  t.ok(content, 'the content swarm exists')
  // Asserting only the control swarm would pass against the ordering bug this guards.
  t.is(typeof content.relayThrough, 'function', 'the content plane carries every file byte')
})

test('selecting a relay is counted on the dialing side too', async (t) => {
  await bootSwarms(t)
  const before = getSwarmStatus().stats.relaying.selected

  setRelayThrough([{ id: 'a', publicKey: KEY_A, enabled: true }], 'always')
  // hyperswarm calls this per outbound dial; hyperdht calls it with no args when
  // announcing. dht.stats.relaying counts only the latter, so without our own counter
  // the peer doing the relaying reports zero.
  getContentSwarm().relayThrough(false, getContentSwarm())
  getContentSwarm().relayThrough()

  t.is(getSwarmStatus().stats.relaying.selected, before + 2, 'both call shapes are counted')
})

test('duplicate relay keys collapse before they reach hyperswarm', async (t) => {
  await bootSwarms(t)
  const hex = b4a.toString(b4a.alloc(32, 11), 'hex')
  // Same key, four encodings. hyperdht picks uniformly at random from the array, so
  // duplicates would skew selection and eat the applied cap.
  const res = setRelayThrough([
    { id: 'a', publicKey: KEY_A, enabled: true },
    { id: 'b', publicKey: hex, enabled: true },
    { id: 'c', publicKey: hex.toUpperCase(), enabled: true },
    { id: 'd', publicKey: `pear://${KEY_A}`, enabled: true },
  ], 'always')
  t.is(res.applied, 1, 'four encodings of one key apply once')
})

test('the applied relay set is capped even when the frame bypasses main', async (t) => {
  await bootSwarms(t)
  const many = []
  for (let i = 0; i < MAX_APPLIED_RELAYS + 5; i++) {
    const key = b4a.alloc(32, 0)
    key[0] = i + 1
    many.push({ id: `r${i}`, publicKey: idEncoding.encode(key), enabled: true })
  }
  // network:set-relays carries the renderer's raw array — main never sanitizes it.
  t.is(setRelayThrough(many, 'always').applied, MAX_APPLIED_RELAYS)
})

test('applying before the content swarm exists would miss the content plane', async (t) => {
  const bootstrap = await localTestnet(t)
  setRuntimeConfig({ storage: null, dhtBootstrap: bootstrap, relayEnabled: true, relayMode: 'always', relays: [] })
  initSwarm(createFakeIpc().ipc)
  t.teardown(async () => {
    try { await destroyContentSwarm() } catch {}
    try { await destroySwarm() } catch {}
  })

  t.is(getContentSwarm(), null, 'null between the two constructors — the window the boot order must clear')
  setRelayThrough([{ id: 'a', publicKey: KEY_A, enabled: true }], 'always')

  initContentSwarm(getSwarmDht())
  t.not(typeof getContentSwarm().relayThrough, 'function', 'a swarm constructed after the call never got it')

  setRelayThrough([{ id: 'a', publicKey: KEY_A, enabled: true }], 'always')
  t.is(typeof getContentSwarm().relayThrough, 'function', 'applying after both constructors fixes it')
})

test('mode off and empty key lists install no relay function', async (t) => {
  await bootSwarms(t)

  setRelayThrough([{ id: 'a', publicKey: KEY_A, enabled: true }], 'off')
  t.is(getContentSwarm().relayThrough, null, 'off is byte-identical to a build without relays')

  setRelayThrough([], 'always')
  t.is(getContentSwarm().relayThrough, null)

  setRelayThrough([{ id: 'a', publicKey: KEY_A, enabled: false }], 'always')
  t.is(getContentSwarm().relayThrough, null, 'a disabled relay is not a relay')
})

test('with the feature flag off, a stale config cannot change transport behaviour', async (t) => {
  await bootSwarms(t, { relayEnabled: false })

  const res = setRelayThrough([{ id: 'a', publicKey: KEY_A, enabled: true }], 'always')
  t.is(res.applied, 0)
  t.is(getContentSwarm().relayThrough, null, 'off means off, whatever config.json says')

  const verdict = await testRelayReachable(KEY_A)
  t.is(verdict.ok, false)
  t.is(verdict.reason, 'disabled', 'the probe refuses to dial on a flag-off build')
})

test('setRelayThrough survives the shutdown window', async (t) => {
  await bootSwarms(t, { relayMode: 'auto' })
  await destroyContentSwarm()
  t.is(getContentSwarm(), null)
  t.execution(() => setRelayThrough([{ id: 'a', publicKey: KEY_A, enabled: true }], 'auto'),
    'a late network:set-relays during teardown must not throw')
})

test('live re-apply needs no restart', async (t) => {
  await bootSwarms(t)

  setRelayConfig('always', [{ id: 'a', publicKey: KEY_A, enabled: true }])
  setRelayThrough([{ id: 'a', publicKey: KEY_A, enabled: true }], 'always')
  const first = getContentSwarm().relayThrough
  t.is(typeof first, 'function')

  setRelayConfig('off', [])
  setRelayThrough([], 'off')
  t.is(getContentSwarm().relayThrough, null, 'turning relays off takes effect immediately')

  setRelayThrough([{ id: 'b', publicKey: KEY_B, enabled: true }], 'always')
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
