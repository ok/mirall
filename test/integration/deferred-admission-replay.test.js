import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import os from 'bare-os'
import fs from 'bare-fs'
import path from 'bare-path'
import { openStore, getStore, setMasterSecret } from '../../src/shared/core/store.js'
import { setRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { initSpaceKeys } from '../../src/shared/spaces/space-keys.js'
import { initProfile, setProfile } from '../../src/shared/spaces/profile.js'
import { initSpaces, createSpace, recordJoinRequest, upsertMember } from '../../src/shared/spaces/space.js'
import {
  connectedPeers, spaceTopics, socketMsgHandlers, pendingRequesters, resetRegistries,
} from '../../src/shared/transfer/swarm-registries.js'
import {
  initDeferredAdmission, resetDeferredAdmission,
  readmitConnectedMembers, reconcilePendingRequestersForApprover,
} from '../../src/shared/transfer/deferred-admission.js'

// Deferred admission has two entry points over one shared replay, and the whole point of the module
// is that they guard it DIFFERENTLY: the reconcile path re-runs the approval gate, the derived path
// trusts the membership fold — which is the only reason the creator, approved by nobody, is ever
// admitted. Pull that gate into the shared replay and a space goes empty for the peer that created
// it, which reads as a replication bug rather than an admission one. These tests pin the asymmetry,
// both in-flight guards, and the identity the replay hands to the handshake.

const hex = () => b4a.toString(crypto.randomBytes(32), 'hex')
const quiet = { debug() {}, info() {}, warn() {}, error() {} }

// Both entry points dispatch their replay without awaiting it, so an assertion has to let the
// microtask chain drain first.
const settle = async (turns = 4) => {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

function tmp(label) {
  const dir = path.join(os.tmpdir(), `defadm-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

async function boot(t, label) {
  const root = tmp(label)
  const storage = path.join(root, 'app-storage')
  t.teardown(async () => {
    try { await getStore().close() } catch {}
    try { fs.rmSync(root, { recursive: true, force: true }) } catch {}
  })
  setRuntimeConfig({ storage })
  await openStore(storage)
  setMasterSecret(b4a.from('44'.repeat(32), 'hex'))
  await initSpaceKeys()
  await initProfile()
  await setProfile({ displayName: 'Alice', avatar: null })
  await initSpaces()
}

// The five dependencies swarm.js injects, replaced by recorders. `gate` counts approval re-checks,
// `handshakes` the direct replays, `prompts` the "send ours to draw a fresh one" fallbacks.
function wire(t, { isApprovedByPeers = async () => true, onPrompt = null } = {}) {
  const calls = { handshakes: [], prompts: 0, gate: 0 }
  initDeferredAdmission({
    getGates: () => ({
      isApprovedByPeers: (space, joinerKey) => { calls.gate++; return isApprovedByPeers(space, joinerKey) },
    }),
    log: quiet,
    handleHandshake: async (_socket, _peerInfo, msg) => { calls.handshakes.push(msg) },
    sendSingleHandshake: (...args) => { calls.prompts++; return onPrompt ? onPrompt(...args) : Promise.resolve() },
    getIpc: () => null,
  })
  t.teardown(() => {
    resetDeferredAdmission()
    resetRegistries()
  })
  return calls
}

// A peer whose handshake was bounced into a join request and whose socket is still live. A driveKey
// means the bounce came from the handshake gate (a member converging); without one all we ever saw
// was a membership:request.
function parkJoiner(spaceId, topic, { driveKey = null, displayName = 'Bob', connected = true } = {}) {
  const joiner = hex()
  const socket = {}
  if (connected) connectedPeers.set(joiner, { socket })
  else pendingRequesters.set(joiner, socket)
  socketMsgHandlers.set(socket, {})
  spaceTopics.set(spaceId, topic)
  recordJoinRequest(spaceId, joiner, displayName, null, driveKey)
  return joiner
}

// REGRESSION (deferred-admission replay name): the replay used to read its displayName from
// listJoinRequests, which deliberately hides every driveKey-bearing entry — so the lookup could
// never match and every readmit sent 'Unknown', which upsertMember then wrote over the member's
// real name.
test('a readmitted member is replayed under the name its bounced handshake carried', async (t) => {
  await boot(t, 'name')
  const calls = wire(t, { isApprovedByPeers: async () => false })
  const space = await createSpace('Derived')
  const driveKey = hex()
  const joiner = parkJoiner(space.spaceId, space.topic, { driveKey, displayName: 'Bob' })

  readmitConnectedMembers(space.spaceId, [joiner])
  await settle()

  t.is(calls.handshakes.length, 1, 'a captured driveKey is replayed directly')
  t.is(calls.handshakes[0].displayName, 'Bob', 'the replay carries the recorded name, not a constant Unknown')
  t.is(calls.handshakes[0].driveKey, driveKey, 'and the driveKey captured alongside it')
  t.is(calls.handshakes[0].profileKey, joiner)
  t.is(calls.handshakes[0].spaceTopic, space.topic)
  t.is(calls.prompts, 0, 'no fallback prompt when we already hold the drive')
  t.is(calls.gate, 0, 'the fold is trusted — no approval re-check, which is how the creator gets in')
})

test('a readmit with no captured driveKey prompts a fresh handshake instead of replaying', async (t) => {
  await boot(t, 'prompt')
  const calls = wire(t)
  const space = await createSpace('Derived')
  const joiner = parkJoiner(space.spaceId, space.topic, { connected: false })

  readmitConnectedMembers(space.spaceId, [joiner])
  await settle()

  t.is(calls.prompts, 1, 'our handshake goes out to draw one back carrying a driveKey')
  t.is(calls.handshakes.length, 0, 'nothing to replay without a drive')
  t.is(calls.gate, 0, 'still no approval re-check on the derived path')
})

test('readmitInflight blocks a concurrent readmit and is released when the replay rejects', async (t) => {
  await boot(t, 'inflight')
  let fail = null
  const parked = new Promise((_resolve, reject) => { fail = reject })
  const calls = wire(t, { onPrompt: () => parked })
  const space = await createSpace('Derived')
  const joiner = parkJoiner(space.spaceId, space.topic, { connected: false })

  readmitConnectedMembers(space.spaceId, [joiner])
  await settle()
  t.is(calls.prompts, 1, 'the first readmit is in flight')

  readmitConnectedMembers(space.spaceId, [joiner])
  await settle()
  t.is(calls.prompts, 1, 'a concurrent readmit for the same (space, peer) is suppressed')

  fail(new Error('socket gone'))
  await settle()

  readmitConnectedMembers(space.spaceId, [joiner])
  await settle()
  t.is(calls.prompts, 2, 'the guard is released even though the replay rejected')
})

test('the reconcile path re-runs the approval gate and admits nothing when it says no', async (t) => {
  await boot(t, 'deny')
  const calls = wire(t, { isApprovedByPeers: async () => false })
  const space = await createSpace('Reconcile')
  const approver = hex()
  await upsertMember(space.spaceId, { publicKey: approver, displayName: 'Approver' })
  parkJoiner(space.spaceId, space.topic, { connected: false })

  await reconcilePendingRequestersForApprover(approver)
  await settle()

  t.is(calls.gate, 1, 'unlike the derived path, reconcile asks isApprovedByPeers')
  t.is(calls.prompts, 0, 'an unapproved joiner is not admitted')
  t.is(calls.handshakes.length, 0)
})

test('pendingAdmitInflight suppresses a second admit pass while the first is parked in the gate', async (t) => {
  await boot(t, 'admit')
  let entered = null
  let release = null
  const atGate = new Promise((resolve) => { entered = resolve })
  const held = new Promise((resolve) => { release = resolve })
  const calls = wire(t, {
    isApprovedByPeers: async () => { entered(); await held; return true },
  })
  const space = await createSpace('Reconcile')
  const approver = hex()
  await upsertMember(space.spaceId, { publicKey: approver, displayName: 'Approver' })
  parkJoiner(space.spaceId, space.topic, { connected: false })

  await reconcilePendingRequestersForApprover(approver)
  await atGate
  await reconcilePendingRequestersForApprover(approver)
  await settle()
  t.is(calls.gate, 1, 'the second pass is suppressed while the first holds the guard')

  release()
  await settle()
  t.is(calls.prompts, 1, 'the surviving pass admits once the gate answers')
  // A joiner the reconcile loop can even see has no driveKey — listJoinRequests hides the ones that
  // do — so this path always prompts rather than replaying.
  t.is(calls.handshakes.length, 0, 'a listed join request is a prompt, never a direct replay')

  await reconcilePendingRequestersForApprover(approver)
  await settle()
  t.is(calls.gate, 2, 'the guard is released once the pass finishes')
})
