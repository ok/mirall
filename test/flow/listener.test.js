import test from 'brittle'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, spawnBareWorker, waitForWorkerExit } from '../helpers/peer.js'
import { scaled } from '../helpers/timing.js'
import { WORKER_EXIT_ALREADY_RUNNING, WORKER_EXIT_ORPHANED } from '../../src/shared/contract/exit-codes.js'

const within = (promise, ms, label) => Promise.race([
  promise,
  new Promise((_resolve, reject) => setTimeout(() => reject(new Error('timed out: ' + label)), scaled(ms))),
])

test('a peer works end to end over the worker socket', { timeout: scaled(60000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const peer = await launchPeer(t, { bootstrap, displayName: 'Alice', transport: 'socket' })
  t.ok(peer.socketPath(), 'the worker announced where it listens')
  const space = await peer.request('space:create', { name: 'Over the socket' })
  const spaces = await peer.request('spaces:list')
  t.ok(spaces.some((s) => s.spaceId === space.spaceId), 'a write and a read both crossed it')
})

test('a second worker on a profile already served exits as already running', { timeout: scaled(60000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const first = await launchPeer(t, { bootstrap, displayName: 'Alice', transport: 'socket' })
  const second = spawnBareWorker(t, { storage: first.storage, flags: { dhtBootstrap: bootstrap } })
  t.is(await within(second.exited, 20000, 'second worker exit'), WORKER_EXIT_ALREADY_RUNNING)
  t.ok(await first.request('profile:get'), 'and the first keeps serving')
})

test('the host going stops the worker even with a socket client attached', { timeout: scaled(60000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const peer = await launchPeer(t, { bootstrap, displayName: 'Alice', transport: 'socket' })
  const pid = peer.sidecar._process.pid
  const exited = new Promise((resolve) => peer.sidecar.once('exit', resolve))
  // The host's end of the spawn pipe closing, as when main dies without a word. The sidecar's own
  // end() does not reach the pipe.
  peer.sidecar._ipc.destroy()
  t.is(await within(exited, 20000, 'worker exit'), WORKER_EXIT_ORPHANED)
  t.ok(await waitForWorkerExit(pid, 8000), 'and the process is gone')
})
