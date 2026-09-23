// @ts-check
// The worker process's own surface: stopping it, proving it answers, and catching a client up on
// the event stream it may have missed.

/** @import { WorkerIpc } from '../../shared/core/ipc.js' */
import { requireHost } from '../../shared/core/client-trust.js'

/** @param {WorkerIpc} ipc @param {{ stop: () => void }} deps */
export function registerWorkerProcess(ipc, { stop }) {
  // A stop, asked for rather than inferred from a pipe going quiet. Answered BEFORE the teardown
  // starts so a caller can tell it landed: the timer fires after the router has written the
  // response, which is a microtask away, and the teardown that follows takes far longer than that to
  // flush.
  ipc.handle('shutdown', (_msg, ctx) => {
    requireHost(ctx.client)
    setTimeout(stop, 0)
    return { ok: true }
  })

  ipc.handle('ping', async () => ({ pong: true, timestamp: Date.now() }))

  // Catch a client up from where it stopped reading, or tell it honestly that it cannot be caught
  // up. The cursor is the caller's own account of what it holds, so the replay is bounded by that
  // and not by when its socket attached: the renderer asks over main's pipe, which has been attached
  // since before the first frame.
  ipc.handle('events:resume', async (msg, ctx) =>
    ipc.resume(ctx.client, { epoch: msg.epoch, since: msg.since ?? 0 }, { sinceAttach: false }))
}
