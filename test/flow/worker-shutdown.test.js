import test from 'brittle'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, waitForWorkerExit } from '../helpers/peer.js'

// Regression guard for the orphaned-worker bug. In production the main process
// reaps the worker on quit by sending a `shutdown` IPC and escalating to a signal;
// it relies on the worker exiting promptly. If the worker stops honoring graceful
// shutdown — e.g. a busy loop starves its event loop so it can't process the IPC —
// it orphans itself at ~100% CPU. These prove both rungs of the escalation make
// the worker process actually exit.

test('a worker exits cleanly on graceful shutdown — no orphaned subprocess', { timeout: 30000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const peer = await launchPeer(t, { bootstrap, displayName: 'Alice' })
  const pid = peer.sidecar._process.pid
  t.ok(pid > 0, 'worker has an OS pid')

  // The shutdown handler calls Bare.exit before replying, so the request settles
  // by pipe-close rather than a response — swallow that rejection.
  await peer.request('shutdown').catch(() => {})

  t.ok(await waitForWorkerExit(pid, 8000),
    'worker process exited within 8s of graceful shutdown (no orphan)')
})

test('a worker is reaped by destroy() (SIGTERM) — the force-kill rung', { timeout: 30000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const peer = await launchPeer(t, { bootstrap, displayName: 'Bob' })
  const pid = peer.sidecar._process.pid

  peer.sidecar.destroy() // bare-sidecar _destroy → _process.kill() = SIGTERM

  t.ok(await waitForWorkerExit(pid, 8000),
    'worker process exited within 8s of SIGTERM (no orphan)')
})
