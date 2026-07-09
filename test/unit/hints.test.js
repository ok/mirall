import test from 'brittle'
import { createHintBus } from '../../src/shared/state/hints.js'

function manualTimers () {
  const pending = []
  return {
    schedule: (fn) => { const id = { fn }; pending.push(id); return id },
    clear: (id) => { const i = pending.indexOf(id); if (i >= 0) pending.splice(i, 1) },
    flush: () => { for (const id of pending.splice(0)) id.fn() },
  }
}

test('HintBus: leading edge fires immediately, a burst coalesces to one trailing', (t) => {
  const emitted = []
  const timers = manualTimers()
  const bus = createHintBus((type, payload) => emitted.push([type, payload.scope]), { schedule: timers.schedule, clear: timers.clear })
  const files = { kind: 'files', spaceId: 'S1' }
  bus.hint(files)
  bus.hint(files)
  bus.hint(files)
  t.is(emitted.length, 1, 'only the leading edge has fired')
  t.alike(emitted[0], ['event:reconcile', files])
  timers.flush()
  t.is(emitted.length, 2, 'one trailing fire for the coalesced burst')
})

test('HintBus: a lone hint fires once, no trailing', (t) => {
  const emitted = []
  const timers = manualTimers()
  const bus = createHintBus((type, payload) => emitted.push(payload.scope), { schedule: timers.schedule, clear: timers.clear })
  bus.hint({ kind: 'files', spaceId: 'S1' })
  timers.flush()
  t.is(emitted.length, 1)
})

test('HintBus: distinct scope keys do not coalesce together', (t) => {
  const emitted = []
  const timers = manualTimers()
  const bus = createHintBus((type, payload) => emitted.push(payload.scope), { schedule: timers.schedule, clear: timers.clear })
  bus.hint({ kind: 'files', spaceId: 'S1' })
  bus.hint({ kind: 'members', spaceId: 'S1' })
  bus.hint({ kind: 'files', spaceId: 'S2' })
  bus.hint({ kind: 'share-files', spaceId: 'S1', shareId: 'A' })
  t.is(emitted.length, 4, 'each distinct (kind, space, share) fires its own leading edge')
})
