import test from 'brittle'
import { setupOwnedShare } from '../helpers/owned.js'
import { getOverlay } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'
import { serveIndex } from '../../src/shared/transfer/backends/overlay/overlay-serve-index.js'
import { registerSpaceLeave } from '../../src/worker/ipc/space-leave.js'

const HASH_LEAVE_ONLY = 'c'.repeat(64)
const HASH_SHARED = 'd'.repeat(64)
const quiet = { debug() {}, info() {}, warn() {}, error() {} }

// One fake peer per grant: revokeServes walks every peer's authorizedServe, and pendingTrees is the
// shape the protocol teardown walks over these injected peers.
function plantGrant(proto, hash, from) {
  const peer = { authorizedServe: new Map([['content:' + hash, { from, epoch: proto._serveEpoch }]]), pendingTrees: new Map() }
  proto._peers.set({ mux: from + hash }, peer)
  return peer
}

test('space:leave revokes the serves of the space it leaves and moves the serve epoch', async (t) => {
  const { fake, root, spaceId } = await setupOwnedShare(t)
  const proto = getOverlay()._protocol
  t.teardown(() => { proto._peers.clear() })

  serveIndex.add(HASH_LEAVE_ONLY, spaceId, 'share1', 'leave.bin')
  serveIndex.add(HASH_SHARED, spaceId, 'share1', 'shared.bin')
  serveIndex.add(HASH_SHARED, 'space-kept', 'share2', 'shared.bin')
  const leaving = plantGrant(proto, HASH_LEAVE_ONLY, 'bob')
  const kept = plantGrant(proto, HASH_SHARED, 'carol')
  const epochBefore = proto._serveEpoch

  registerSpaceLeave(fake.ipc, {
    log: quiet,
    mounts: root.mounts,
    overlayBackend: root.overlayBackend,
    discardPendingSpace: async () => {},
    dropSpaceDownloadRoot: () => {},
  })
  const res = await fake.call('space:leave', { spaceId })

  t.alike(res, { ok: true }, 'the leave completes')
  t.absent(leaving.authorizedServe.has('content:' + HASH_LEAVE_ONLY), 'a hash only the left space advertised stops being served')
  t.ok(kept.authorizedServe.has('content:' + HASH_SHARED), 'a hash a kept space also advertises keeps its grant')
  t.ok(proto._serveEpoch > epochBefore, 'the epoch moved, so every surviving grant re-runs the gate')
})
