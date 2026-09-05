import test from 'brittle'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import crypto from 'hypercore-crypto'
import { initStore, setMasterSecret } from '../../src/shared/core/store.js'
import { initAuditLog, flushAudit, queryAudit, purgeAudit, setAuditConfig, getNetworkState } from '../../src/shared/audit/audit-log.js'
import {
  initNetworkWatch, resetNetworkWatch, observeReachability, peerLost, peerLostMeta, peerSeen, peerLeft,
} from '../../src/shared/audit/network-watch.js'
import { createTimers } from '../../src/shared/core/timers.js'

// The watch arms its dwell timeouts through the owning subsystem's set (AuditLog hands it
// this.timers), so a test driving the module directly has to supply one too — without it the
// re-arming tails have nothing to arm through and every dwell assertion below would wait forever.
let watchTimers = null

const DWELL = 60
const META = { memberName: 'Anna Keller', spaceName: 'Design Team' }

let seq = 0
function tmpDir (label) {
  const dir = path.join(os.tmpdir(), `netwatch-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${seq++}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const settle = () => sleep(DWELL * 4)

async function boot (t, { session = 'run-1' } = {}) {
  const storage = tmpDir('store')
  t.teardown(() => {
    resetNetworkWatch()
    watchTimers?.close()
    watchTimers = null
    try { fs.rmSync(storage, { recursive: true, force: true }) } catch {}
  })
  initStore(storage)
  setMasterSecret(crypto.randomBytes(32))
  await initAuditLog({ installId: 'install-under-test' })
  await setAuditConfig({ enabled: true, retentionDays: 90, maxEntries: 200000 })
  await purgeAudit()
  watchTimers = createTimers()
  initNetworkWatch({ sessionId: session, dwellMs: DWELL, peerDwellMs: DWELL, timers: watchTimers })
}

function observe (verdict, cause = null, since = Date.now()) {
  observeReachability({
    verdict,
    cause,
    since,
    evidence: { confidence: 'measured', peersDiscovered: 4, peersExhausted: 4, peersConnected: 0, publicPort: 0, interfaceKind: 'physical' },
  })
}

async function kinds () {
  await flushAudit()
  const { entries } = await queryAudit({ limit: 200 })
  return entries.map((e) => e.kind)
}

async function rowOf (kind) {
  await flushAudit()
  const { entries } = await queryAudit({ limit: 200 })
  return entries.find((e) => e.kind === kind) || null
}

test('a held degradation is written once, with the cause and the real start', async (t) => {
  await boot(t)
  const since = Date.now()
  observe('blocked', 'peers-unreachable', since)
  await settle()

  const row = await rowOf('network.blocked')
  t.ok(row, 'the outage was recorded')
  t.is(row.code, 'peers-unreachable')
  t.is(row.category, 'network')
  t.is(row.tier, 'A')
  t.is(row.space, null, 'device-scoped')
  t.is(row.actor.type, 'system')
  t.is(row.subject.sinceTs, since, 'the row names the transition, not the write')
  t.is(row.subject.peersExhausted, 4, 'and freezes the evidence that distinguishes the blocked shapes')

  observe('blocked', 'peers-unreachable', since)
  await settle()
  t.is((await kinds()).filter((k) => k === 'network.blocked').length, 1, 'never a second row while it holds')
})

test('recovery closes the episode with a duration and clears the standing state', async (t) => {
  await boot(t)
  const start = Date.now()
  observe('blocked', 'os-offline', start)
  await settle()
  t.ok(await getNetworkState(), 'the degradation is persisted')

  const back = start + 5000
  observe('healthy', null, back)
  await settle()

  const row = await rowOf('network.restored')
  t.ok(row)
  t.is(row.code, 'os-offline', 'the row names what it recovered from')
  t.is(row.subject.fromKind, 'network.offline')
  t.is(row.subject.durationMs, 5000)
  t.is(await getNetworkState(), null, 'and the standing state is cleared')
})

test('a flap inside the hold-down leaves no trace at all', async (t) => {
  await boot(t)
  observe('blocked', 'os-offline')
  observe('healthy')
  await settle()
  t.alike(await kinds(), [], 'no offline row and no restored row')
  t.is(await getNetworkState(), null)
})

test('a peer absence past the floor is recorded, and its return closes it', async (t) => {
  await boot(t)
  observe('healthy')
  await settle()

  peerLost('anna', 'sp1', META)
  await settle()

  const lost = await rowOf('network.peer_lost')
  t.ok(lost)
  t.is(lost.tier, 'B')
  t.is(lost.actor.key, 'anna')
  t.is(lost.actor.name, 'Anna Keller', 'the name is snapshotted at loss')
  t.is(lost.space.id, 'sp1')
  t.is(lost.space.name, 'Design Team')

  peerSeen('anna', 'sp1')
  await flushAudit()
  const back = await rowOf('network.peer_back')
  t.ok(back)
  t.ok(back.subject.durationMs >= DWELL)
})

test('a peer that returns below the floor produces nothing', async (t) => {
  await boot(t)
  observe('healthy')
  await settle()

  peerLost('anna', 'sp1', META)
  peerSeen('anna', 'sp1')
  await settle()
  t.alike(await kinds(), [], 'not even a lone "is back online"')
})

// When we are the problem every peer looks unreachable, and the device row already says why.
test('peer absences are suppressed while OUR OWN connectivity is degraded', async (t) => {
  await boot(t)
  observe('blocked', 'os-offline')
  await settle()

  peerLost('anna', 'sp1', META)
  peerLost('bob', 'sp1', META)
  await settle()

  const seen = await kinds()
  t.absent(seen.includes('network.peer_lost'), 'no peer is blamed for our outage')
  t.ok(seen.includes('network.offline'), 'the device row carries the story instead')
})

test('an absence already open when we go degraded is abandoned, not recorded', async (t) => {
  await boot(t)
  observe('healthy')
  peerLost('anna', 'sp1', META)
  observe('blocked', 'os-offline')
  await settle()

  const seen = await kinds()
  t.absent(seen.includes('network.peer_lost'), 'the pending absence was dropped when we became the cause')
  t.ok(seen.includes('network.offline'))
})

test('a leave is not a disconnect', async (t) => {
  await boot(t)
  observe('healthy')
  await settle()

  peerLost('anna', 'sp1', META)
  peerLeft('anna', 'sp1')
  await settle()
  t.alike(await kinds(), [], 'member.left carries a leave; this must not double it')
})

test('a disabled log records nothing and does not advance the standing state', async (t) => {
  await boot(t)
  await setAuditConfig({ enabled: false })
  observe('blocked', 'dht-unreachable')
  await settle()
  t.is(await getNetworkState(), null, 'a refused write must not suppress the next one')

  await setAuditConfig({ enabled: true })
  observe('blocked', 'dht-unreachable')
  await settle()
  t.ok(await rowOf('network.blocked'), 're-enabling records the standing state')
})

test('relaunching on the same bad network is silent', async (t) => {
  await boot(t)
  observe('blocked', 'no-public-address')
  await settle()
  t.is((await kinds()).filter((k) => k === 'network.blocked').length, 1)

  watchTimers = createTimers()
  initNetworkWatch({ sessionId: 'run-2', dwellMs: DWELL, peerDwellMs: DWELL, timers: watchTimers })
  observe('blocked', 'no-public-address')
  await settle()
  t.is((await kinds()).filter((k) => k === 'network.blocked').length, 1, 'the first launch already said so')
})

test('an outage spanning a restart recovers without inventing a duration', async (t) => {
  await boot(t)
  observe('blocked', 'os-offline')
  await settle()

  watchTimers = createTimers()
  initNetworkWatch({ sessionId: 'run-2', dwellMs: DWELL, peerDwellMs: DWELL, timers: watchTimers })
  observe('healthy')
  await settle()

  const row = await rowOf('network.restored')
  t.ok(row)
  t.is(row.subject.durationMs, null, 'the app was closed for an unknown part of it')
  t.is(row.subject.fromKind, 'network.offline', 'but what it recovered from is still known')
})

// A step that produces no row returns from inside the try, so the pending-drain used to be dead
// code: an observation arriving mid-step was dropped, and with a stable-blocked idle app nothing
// re-triggers it.
test('an observation arriving mid-step is not dropped', async (t) => {
  await boot(t)
  observe('healthy')
  observe('blocked', 'os-offline')
  await settle()
  t.ok(await rowOf('network.offline'), 'the second observation still produced its row')
})

test('the space name can land after the loss is captured', async (t) => {
  await boot(t)
  observe('healthy')
  await settle()

  peerLost('anna', 'sp1', { memberName: 'Anna Keller', spaceName: null })
  peerLostMeta('anna', 'sp1', { spaceName: 'Design Team' })
  await settle()

  const row = await rowOf('network.peer_lost')
  t.is(row.space.name, 'Design Team', 'the async name lookup patched the open episode')
  t.is(row.actor.name, 'Anna Keller')
})

// peerSeen and peerLeft are synchronous; the loss must be too, or a reconnect overtakes it.
test('a reconnect racing the loss does not leave a phantom absence', async (t) => {
  await boot(t)
  observe('healthy')
  await settle()

  peerLost('anna', 'sp1', { memberName: 'Anna Keller', spaceName: 'Design Team' })
  peerSeen('anna', 'sp1')
  peerLostMeta('anna', 'sp1', { spaceName: 'Design Team' })
  await settle()

  t.alike(await kinds(), [], 'the episode closed before the floor, so nothing was recorded')
})
