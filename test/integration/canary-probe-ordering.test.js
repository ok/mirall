import test from 'brittle'
import crypto from 'hypercore-crypto'
import idEncoding from 'hypercore-id-encoding'
import {
  initConnectivity, attachSwarmWatchers, resetConnectivity, probeCanary,
} from '../../src/shared/transfer/connectivity.js'

const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const silentLog = { debug () {}, info () {}, warn () {}, error () {} }

// A DHT lookup we can hold open. runCanaryProbe iterates the stream to collect announce records, so
// a stream that yields nothing until released is a probe parked in its first stage.
function heldLookup () {
  let release = null
  const closed = new Promise((resolve) => { release = resolve })
  return {
    release: () => release(),
    destroy () { release() },
    async * [Symbol.asyncIterator] () { await closed },
  }
}

const emptyLookup = () => ({ destroy () {}, async * [Symbol.asyncIterator] () {} })

function fakeSwarm (lookups) {
  const dht = {
    on () {},
    fullyBootstrapped: async () => {},
    lookup: () => lookups.shift(),
    firewalled: false,
    randomized: false,
  }
  return { on () {}, dht, suspended: false, destroyed: false, connections: new Set() }
}

async function connectivity (t, lookups) {
  initConnectivity({
    log: silentLog,
    diag: { snapshotPeerSamples: () => [], counters: () => ({}) },
    dhtVersion: () => 'test',
    getDroppedFrameCounters: () => ({}),
    getSwarm: () => fakeSwarm(lookups),
    getIpc: () => null,
  })
  t.teardown(() => resetConnectivity())
  attachSwarmWatchers()
  await delay(20)                       // fullyBootstrapped resolves, so the DHT reads as ready
}

// REGRESSION (FIX-CANARY-STALE-RESULT: only the in-flight HANDLE was identity-guarded. The two
// result-writing arms were not, so when a forced probe overtook a slow one, the slow one's verdict
// landed afterwards — overwriting the newer answer AND stamping it with a later timestamp. The
// 15-minute freshness gate then served that stale verdict to every caller for another quarter of
// an hour, and it is what the renderer shows as the network status.)
test('REGRESSION (FIX-CANARY-STALE-RESULT): a slow probe that settles last does not overwrite the newer verdict',
  async (t) => {
    const held = heldLookup()
    await connectivity(t, [held, emptyLookup()])
    const key = idEncoding.encode(crypto.randomBytes(32))

    // Both forced: `force` is what the user-triggered path passes, and it is the only way two
    // probes are ever in flight at once — which is the race the guard exists for.
    let slowSettled = false
    const slow = probeCanary(key, { force: true }).then((r) => { slowSettled = true; return r })
    await delay(5)
    const fast = await probeCanary(key, { force: true }) // overtakes it and answers now
    t.ok(fast.stage1.ms < 60, 'the forced probe answered promptly')

    await delay(80)
    t.absent(slowSettled, 'the first probe is still parked, so it can only settle after the newer one')
    held.release()
    await slow

    // Not forced, so this is served straight from the latched verdict — the same value the swarm
    // status reports to the renderer, for the next fifteen minutes.
    const latest = await probeCanary(key)
    t.is(latest.stage1.ms, fast.stage1.ms,
      'the latched verdict is the newer probe\'s, not the stale one that finished last')
    t.ok(latest.stage1.ms < 60, 'and it carries the newer probe\'s timings, not an 80ms stage 1')
  })
