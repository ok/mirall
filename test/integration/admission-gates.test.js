import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import { freshPeer } from '../helpers/store.js'
import { makePeer, replicate } from '../helpers/peer-bee.js'
import { getStore } from '../../src/shared/core/store.js'
import { setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { createAdmissionGates } from '../../src/shared/network/admission-gates.js'

// The approval gate asks the fold first, then every other member's bee concurrently under ONE
// admission budget: an offline member costs at most that budget once, never once per member.

const SPACE = 'space-admission'
const hex = () => b4a.toString(crypto.randomBytes(32), 'hex')
const quiet = { debug() {}, info() {}, warn() {}, error() {} }
const delay = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms))

function withConfig(t, patch) {
  const prev = getRuntimeConfig()
  setRuntimeConfig({ ...prev, ...patch })
  t.teardown(() => setRuntimeConfig(prev))
}

function gates(overrides = {}) {
  return createAdmissionGates({ connectedPeers: new Map(), log: quiet, getIpc: () => null, ...overrides })
}

// Discovery still running: a read of a member no peer serves waits out its whole budget, which is
// what an offline member costs in production.
function lookingForPeers(t) {
  const done = getStore().findingPeers()
  t.teardown(done)
}

const spaceOf = (memberKeys) => ({ spaceId: SPACE, members: memberKeys.map((publicKey) => ({ publicKey })) })

// A stub approval reader that records concurrency, call order and the budget each read was given.
// `ms` is how long a miss takes; a function of the budget models an offline member that holds its
// read for the whole budget it was given.
function recordingReader({ approves = () => false, ms = 50 } = {}) {
  const rec = { calls: [], inFlight: 0, maxInFlight: 0, budgets: [] }
  rec.read = async (approverKey, _spaceId, _joinerKey, { timeoutMs }) => {
    rec.calls.push(approverKey)
    rec.budgets.push(timeoutMs)
    rec.inFlight++
    rec.maxInFlight = Math.max(rec.maxInFlight, rec.inFlight)
    const verdict = approves(approverKey)
    await delay(verdict ? 10 : (typeof ms === 'function' ? ms(approverKey, timeoutMs) : ms))
    rec.inFlight--
    return verdict
  }
  return rec
}

test('REGRESSION (FIX-377: admission waited one peer-read timeout per offline member, serially)', async (t) => {
  await freshPeer(t)
  // absolute: the budgets are passed INTO the gate; the assertion is that it answers inside one.
  withConfig(t, { peerReadTimeoutMs: 3000, admissionReadTimeoutMs: 1000 })
  const joiner = hex()
  const approver = await makePeer(t)
  await approver.bee.put('approved/' + SPACE + '/' + joiner, { ts: 1 })
  replicate(getStore(), approver.store, t)
  lookingForPeers(t)

  const t0 = Date.now()
  const admitted = await gates().isApprovedByPeers(spaceOf([hex(), hex(), hex(), approver.key]), joiner)
  const dt = Date.now() - t0

  t.ok(admitted, 'the reachable approver admits the joiner')
  t.ok(dt < 3000, 'inside one peer-read budget, not one per offline member (' + dt + 'ms)')
})

test('with every other member offline the gate says no within one admission budget', async (t) => {
  await freshPeer(t)
  // absolute: the budgets are passed INTO the gate; the assertion is that it answers inside one.
  withConfig(t, { peerReadTimeoutMs: 5000, admissionReadTimeoutMs: 600 })
  lookingForPeers(t)

  const t0 = Date.now()
  const admitted = await gates().isApprovedByPeers(spaceOf([hex(), hex(), hex()]), hex())
  const dt = Date.now() - t0

  t.absent(admitted, 'no member vouches')
  t.ok(dt >= 500, 'the offline members were given the budget (' + dt + 'ms)')
  t.ok(dt < 3000, 'answered on the admission budget, not the peer-read budget')
})

test('a joiner the fold already approved is admitted with no peer read', async (t) => {
  await freshPeer(t)
  withConfig(t, { peerReadTimeoutMs: 300 })
  const reader = recordingReader()
  const joiner = hex()

  const admitted = await gates({
    readApproval: reader.read,
    isFoldApproved: (spaceId, key) => spaceId === SPACE && key === joiner,
  }).isApprovedByPeers(spaceOf([hex(), hex()]), joiner)

  t.ok(admitted, 'the fold vouches')
  t.is(reader.calls.length, 0, 'no member bee was read')
})

test('never more than eight approval reads are in flight', async (t) => {
  await freshPeer(t)
  withConfig(t, { peerReadTimeoutMs: 300, admissionReadTimeoutMs: 4000 })
  const reader = recordingReader({ ms: 30 })
  const members = Array.from({ length: 20 }, hex)

  const admitted = await gates({ readApproval: reader.read, isFoldApproved: () => false })
    .isApprovedByPeers(spaceOf(members), hex())

  t.absent(admitted, 'no member vouches')
  t.is(reader.calls.length, 20, 'every member was asked')
  t.is(reader.maxInFlight, 8, 'at most eight at a time')
  const [first, queued] = [reader.budgets.slice(0, 8), reader.budgets.slice(8)]
  t.ok(Math.min(...first) - Math.max(...queued) >= 20, 'a queued read gets only what is left of the budget (' + first[0] + ' then ' + queued[0] + ')')
})

test('no read starts after the first approval', async (t) => {
  await freshPeer(t)
  withConfig(t, { peerReadTimeoutMs: 300, admissionReadTimeoutMs: 4000 })
  const members = Array.from({ length: 20 }, hex)
  const reader = recordingReader({ approves: (key) => key === members[1], ms: 200 })

  const admitted = await gates({ readApproval: reader.read, isFoldApproved: () => false })
    .isApprovedByPeers(spaceOf(members), hex())
  await delay(300)

  t.ok(admitted, 'the approving member admits the joiner')
  t.is(reader.calls.length, 8, 'only the first window of reads ever started')
})

test('the joiner and this peer are never asked', async (t) => {
  await freshPeer(t)
  withConfig(t, { peerReadTimeoutMs: 300, admissionReadTimeoutMs: 4000 })
  const { getLocalPublicKeyHex } = await import('../../src/shared/spaces/profile.js')
  const reader = recordingReader({ ms: 5 })
  const joiner = hex()
  const other = hex()

  await gates({ readApproval: reader.read, isFoldApproved: () => false })
    .isApprovedByPeers(spaceOf([getLocalPublicKeyHex(), joiner, other]), joiner)

  t.alike(reader.calls, [other], 'only the other member')
})

const connectedIn = (...keys) => new Map(keys.map((key) => [key, { spaces: new Set([SPACE]) }]))

test('offline members listed first cannot hold every slot from a connected approver', async (t) => {
  await freshPeer(t)
  withConfig(t, { peerReadTimeoutMs: 300, admissionReadTimeoutMs: 4000 })
  const members = Array.from({ length: 12 }, hex)
  const offline = new Set(members.slice(0, 8))
  const reader = recordingReader({
    approves: (key) => key === members[10],
    ms: (key, timeoutMs) => (offline.has(key) ? timeoutMs : 20),
  })

  const t0 = Date.now()
  const admitted = await gates({ connectedPeers: connectedIn(members[10]), readApproval: reader.read, isFoldApproved: () => false })
    .isApprovedByPeers(spaceOf(members), hex())
  const dt = Date.now() - t0

  t.ok(admitted, 'the connected approver admits the joiner')
  t.is(reader.calls[0], members[10], 'the connected member is asked first')
  t.ok(dt < 1000, 'well inside the admission budget (' + dt + 'ms)')
})

test('an unconnected approver queued behind misses is still read once a slot frees', async (t) => {
  await freshPeer(t)
  withConfig(t, { peerReadTimeoutMs: 300, admissionReadTimeoutMs: 4000 })
  const members = Array.from({ length: 12 }, hex)
  const reader = recordingReader({ approves: (key) => key === members[10], ms: 150 })

  const t0 = Date.now()
  const admitted = await gates({ readApproval: reader.read, isFoldApproved: () => false })
    .isApprovedByPeers(spaceOf(members), hex())
  const dt = Date.now() - t0

  t.ok(admitted, 'the approver is reached before the deadline')
  t.ok(dt < 1000, 'after one round of misses, not the whole budget (' + dt + 'ms)')
})

test('no approval read starts after the admission deadline', async (t) => {
  await freshPeer(t)
  withConfig(t, { peerReadTimeoutMs: 300, admissionReadTimeoutMs: 200 })
  const reader = recordingReader({ ms: (_key, timeoutMs) => timeoutMs })
  const members = Array.from({ length: 20 }, hex)

  const t0 = Date.now()
  const admitted = await gates({ readApproval: reader.read, isFoldApproved: () => false })
    .isApprovedByPeers(spaceOf(members), hex())
  const dt = Date.now() - t0
  await delay(300)

  t.absent(admitted, 'no member vouches in time')
  t.ok(dt < 1000, 'answered at the deadline (' + dt + 'ms)')
  t.is(reader.calls.length, 8, 'only the reads started before the deadline ever ran')
  t.ok(reader.budgets.every((ms) => ms >= 1), 'no read was handed a budget under 1 ms')
})
