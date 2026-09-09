import test from 'brittle'
import { setupSelfMirror } from '../helpers/owned.js'
import { getOverlay } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'
import { initialMaterializeScan, runMaterializeTick } from '../../src/shared/folders/foreign-folders.js'

// The offline half of the gate is NOT tested here, deliberately. A remote-owner mount cannot be
// faked at this layer: loadShareForForeignMount -> readPeerShares returns null for a key with no
// peer bee, so materializeOnce returns at `if (!share)` and never reaches the gate — the test would
// pass with the gate deleted. That half lives in test/flow/mirror-offline-idle.test.js, where
// "offline" is a real peer shutting down.

// A well-formed scheduler-end frame. Passing one is what makes `attempted` true, which is the whole
// difference between "a holder was asked and died" and "there was no holder at all".
const SCHEDULER_END = {
  reason: 'timeout', receivedBytes: 0, totalBytes: 1, totalChunks: 1, chunksRemaining: 1, peers: 1, elapsedMs: 10,
}

// Count fetches without changing what they do: setupSelfMirror already installs a working stub.
function countFetches (t) {
  const overlay = getOverlay()
  const inner = overlay.fetchFile
  const state = { calls: 0 }
  overlay.fetchFile = async (hash, opts) => { state.calls++; return await inner(hash, opts) }
  t.teardown(() => { overlay.fetchFile = inner })
  return state
}

// REGRESSION (FIX-MIRROR-OFFLINE): the reachability gate must special-case a self-mirror. Presence
// never leases our own key, so a bare isOwnerOnline(mount.ownerKey) reads it as permanently offline
// and the mirror never fetches anything again. This is the landmine the whole change balances on:
// it goes red on a gate written the obvious way, green on the shipped one.
test('REGRESSION (FIX-MIRROR-OFFLINE): a self-mirror still materializes under the gate', async (t) => {
  const ctx = await setupSelfMirror(t, { files: { 'a.txt': 'x', 'b.txt': 'y' } })
  const fetches = countFetches(t)
  await initialMaterializeScan(ctx.mount)
  t.is(fetches.calls, 2, 'both files were fetched — the gate did not mistake us for an offline peer')
})

// A fetchFile that resolves null WITHOUT calling onEnd is exactly what the vendor does when
// _peers.size === 0 (vendor/overlay-v2.js) — the shape the reported bug ran on. That answer is a
// process-global fact, so the pass must stop rather than re-ask it once per file.
test('a zero-peer answer stops the pass instead of re-asking per file', async (t) => {
  const ctx = await setupSelfMirror(t, { files: { 'a.txt': '1', 'b.txt': '2', 'c.txt': '3', 'd.txt': '4' } })
  const overlay = getOverlay()
  const inner = overlay.fetchFile
  let calls = 0
  overlay.fetchFile = async () => { calls++; return null }
  t.teardown(() => { overlay.fetchFile = inner })

  await runMaterializeTick(ctx.spaceId, ctx.share.id)
  t.is(calls, 1, 'one peer wait for the whole pass, not one per file')
})

// The other half of the same rule: a holder that WAS asked and died is a per-file fact, so the walk
// must carry on. Without this the fix would turn one bad file into a stalled folder.
test('a stalled holder does NOT stop the pass — that fact is per file', async (t) => {
  const ctx = await setupSelfMirror(t, { files: { 'a.txt': '1', 'b.txt': '2', 'c.txt': '3' } })
  const overlay = getOverlay()
  const inner = overlay.fetchFile
  let calls = 0
  overlay.fetchFile = async (hash, opts) => { calls++; opts?.onEnd?.(SCHEDULER_END); return null }
  t.teardown(() => { overlay.fetchFile = inner })

  await runMaterializeTick(ctx.spaceId, ctx.share.id)
  t.is(calls, 3, 'every file was still attempted')
})

// A pass that stopped early walked a PREFIX, so it must not be able to converge. If 'no-peers' ever
// read as present, the mirror would set a watermark and stop walking with nothing on disk — a
// silent, permanent sync outage that no later tick would repair.
test('a pass stopped early never converges', async (t) => {
  const ctx = await setupSelfMirror(t, { files: { 'a.txt': '1', 'b.txt': '2', 'c.txt': '3' } })
  const overlay = getOverlay()
  const real = overlay.fetchFile
  const state = { peers: false, calls: 0 }
  overlay.fetchFile = async (hash, opts) => {
    state.calls++
    return state.peers ? await real(hash, opts) : null
  }
  t.teardown(() => { overlay.fetchFile = real })

  await runMaterializeTick(ctx.spaceId, ctx.share.id)
  t.is(state.calls, 1, 'the zero-peer pass stopped after one attempt')

  state.peers = true
  state.calls = 0
  await runMaterializeTick(ctx.spaceId, ctx.share.id)
  t.is(state.calls, 3, 'the next tick walked the whole catalog — the partial pass set no watermark')
})
