import test from 'brittle'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, waitForWorkerExit } from '../helpers/peer.js'
import { scaled } from '../helpers/timing.js'

// Regression guard for the orphaned-worker bug. In production the main process
// reaps the worker on quit by sending a `shutdown` IPC and escalating to a signal;
// it relies on the worker exiting promptly. If the worker stops honoring graceful
// shutdown — e.g. a busy loop starves its event loop so it can't process the IPC —
// it orphans itself at ~100% CPU. These prove both rungs of the escalation make
// the worker process actually exit.

test('a worker exits cleanly on graceful shutdown — no orphaned subprocess', { timeout: scaled(30000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const peer = await launchPeer(t, { bootstrap, displayName: 'Alice' })
  const pid = peer.sidecar._process.pid
  t.ok(pid > 0, 'worker has an OS pid')

  // The stop is acknowledged before the teardown begins, so the caller can tell it landed rather
  // than inferring it from the pipe going quiet.
  t.alike(await peer.request('shutdown'), { ok: true }, 'the stop is acknowledged')

  t.ok(await waitForWorkerExit(pid, 8000),
    'worker process exited within 8s of graceful shutdown (no orphan)')
})

test('a worker is reaped by destroy() (SIGTERM) — the force-kill rung', { timeout: scaled(30000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const peer = await launchPeer(t, { bootstrap, displayName: 'Bob' })
  const pid = peer.sidecar._process.pid

  peer.sidecar.destroy() // bare-sidecar _destroy → _process.kill() = SIGTERM

  t.ok(await waitForWorkerExit(pid, 8000),
    'worker process exited within 8s of SIGTERM (no orphan)')
})

// A worker not yet handed its key serves only the recovery set, and the stop is part of it: it exits
// cleanly, with the code of a stop that was asked for rather than one of a worker that failed.
test('a worker still waiting for its key exits cleanly on graceful shutdown', { timeout: scaled(30000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const peer = await launchPeer(t, { bootstrap, unlock: false, setProfile: false })
  const exited = new Promise((resolve) => peer.sidecar._process.once('exit', (code) => resolve(code)))
  t.is((await peer.request('identity:status')).code, 'IDENTITY_AWAITING_KEY', 'waiting')
  t.alike(await peer.request('shutdown'), { ok: true }, 'the stop is acknowledged')
  t.is(await exited, 0, 'and the worker exits 0')
})
