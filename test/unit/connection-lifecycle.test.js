import test from 'brittle'
import { EventEmitter } from 'events'
import { afterLastClient, bindConnectionLifecycle } from '../../src/worker/connection-lifecycle.js'

test('the verdict truth table', (t) => {
  const v = (clients, bootComplete, canAcceptClients) => afterLastClient({ clients, bootComplete, canAcceptClients })
  t.is(v(1, true, false), 'stay', 'someone is still connected')
  t.is(v(2, false, true), 'stay')
  t.is(v(0, true, false), 'stop', 'nobody, and no way for anybody to arrive')
  // The orphan guard: the parent died during startup and will never send the bootstrap frame, so
  // there is nothing to linger for even on a worker that could accept a connection.
  t.is(v(0, false, false), 'stop')
  t.is(v(0, false, true), 'stop')
  t.is(v(0, true, true), 'linger', 'a worker that can be reconnected to stays up')
})

function harness({ canAcceptClients = false, clientsAfter = 0, bootComplete = true } = {}) {
  const pipe = new EventEmitter()
  const calls = []
  const ipc = {
    detach: (client, reason) => { calls.push(['detach', client.id, reason]); return 0 },
    clientCount: () => clientsAfter,
  }
  bindConnectionLifecycle({
    pipe,
    ipc,
    client: { id: 1 },
    isBootComplete: () => bootComplete,
    canAcceptClients,
    stop: (reason) => calls.push(['stop', reason]),
  })
  return { pipe, calls }
}

test('a closed pipe detaches the client first, then decides', (t) => {
  const { pipe, calls } = harness()
  pipe.emit('close')
  t.alike(calls, [['detach', 1, 'ipc-close'], ['stop', 'ipc-close']],
    'the client goes away whatever the verdict; stopping is a separate question')
})

test('end, close and error together act once', (t) => {
  const { pipe, calls } = harness()
  pipe.emit('end')
  pipe.emit('close')
  pipe.emit('error', new Error('EPIPE'))
  t.is(calls.filter(([kind]) => kind === 'detach').length, 1)
  t.is(calls.filter(([kind]) => kind === 'stop').length, 1)
})

test('an error carries its message into the reason', (t) => {
  const { pipe, calls } = harness()
  pipe.emit('error', new Error('EPIPE'))
  t.ok(calls[0][2].includes('EPIPE'))
})

// This is the P2 behaviour, provable now: the mechanism is in place and only the policy input
// changes when the worker can accept a connection of its own.
test('a worker that can accept clients is NOT stopped by its last one leaving', (t) => {
  const { pipe, calls } = harness({ canAcceptClients: true })
  pipe.emit('close')
  t.alike(calls, [['detach', 1, 'ipc-close']], 'detached, and still serving')
})

test('the orphan guard fires before boot even for a worker that could accept clients', (t) => {
  const { pipe, calls } = harness({ canAcceptClients: true, bootComplete: false })
  pipe.emit('close')
  t.is(calls.filter(([kind]) => kind === 'stop').length, 1,
    'nothing will ever send the bootstrap frame it is waiting for')
})

test('a second client keeps the worker up', (t) => {
  const { pipe, calls } = harness({ clientsAfter: 1 })
  pipe.emit('close')
  t.alike(calls, [['detach', 1, 'ipc-close']])
})

// REGRESSION (FIX-405-2: the exit code was last-writer-wins, and shutdowns arrive in pairs. A
// requested stop runs a teardown that can take seconds, main's escalation closes the pipe
// underneath it at 3s, and the pipe-close reason then relabelled a clean quit as an orphaned
// worker — on every slow teardown, which is every large library.)
test('REGRESSION (FIX-405-2): a pipe closing during a teardown does not relabel the exit', (t) => {
  // The shape of worker/main.js's safeShutdown, minus Bare.exit.
  let shuttingDown = false
  let exitCode = 0
  const safeShutdown = (reason, code = 0) => {
    if (shuttingDown) return
    exitCode = code
    shuttingDown = true
  }

  safeShutdown('shutdown-request', 0)
  safeShutdown('ipc-close', 72)
  t.is(exitCode, 0, 'the stop the host asked for is what this exit was')
})
