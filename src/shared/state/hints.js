import { makeKeyedCoalescer } from './coalesce.js'

// The single worker->renderer status channel. hint(scope) coalesces (leading + trailing) into
// one `event:reconcile { scope }`. Hints are thin (scope only) and lossy by design: every
// consumer re-derives from durable state, so a dropped hint costs latency, never correctness.

export function createHintBus(emit, { intervalMs = 200, schedule, clear } = {}) {
  const engine = makeKeyedCoalescer((scope) => emit('event:reconcile', { scope }), {
    intervalMs,
    keyOf: (s) => [s.kind, s.spaceId ?? '', s.shareId ?? ''].join('|'),
    schedule,
    clear,
  })
  return { hint: engine.poke, reset: engine.reset }
}
