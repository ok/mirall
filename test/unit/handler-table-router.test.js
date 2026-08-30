import test from 'brittle'
import { createIPC, getRequestFailureCounters, resetRequestFailureCounters } from '../../src/shared/core/ipc.js'
import { setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { ARG } from '../../src/shared/contract/requests.js'
import { INVALID_ARGUMENT } from '../../src/shared/contract/errors.js'

const TEST_REQUESTS = Object.freeze({
  'thing:do': { kind: 'command', args: { spaceId: { type: ARG.spaceId }, count: { type: ARG.number, optional: true } } },
  'thing:free': { kind: 'query', args: {} },
})

function fakePipe () {
  const written = []
  let onData = null
  return {
    write: (s) => { written.push(s); return true },
    on: (evt, fn) => { if (evt === 'data') onData = fn },
    feed: (obj) => onData(Buffer.from(JSON.stringify(obj) + '\n')),
    written,
    reply: (id) => JSON.parse(written.find((w) => w.includes(`"id":${id}`))),
  }
}

function setup (t) {
  const prev = getRuntimeConfig()
  setRuntimeConfig({ ...prev, verbose: false })
  resetRequestFailureCounters()
  const warns = []
  const origWarn = console.warn
  console.warn = (...a) => warns.push(a.join(' '))
  t.teardown(() => { console.warn = origWarn; setRuntimeConfig(prev); resetRequestFailureCounters() })
  const pipe = fakePipe()
  const ipc = createIPC(pipe, { requests: TEST_REQUESTS })
  return { ipc, pipe, warns }
}

const flush = () => new Promise((r) => setTimeout(r, 20))

// REGRESSION (FIX-HANDLER-VALIDATION: 85 handlers shared four `typeof msg.` checks between them, so
// a malformed payload reached a handler body and failed as an internal error from somewhere deep in
// the call stack — if it failed at all.)
test('REGRESSION (FIX-HANDLER-VALIDATION): a malformed payload never reaches the handler', async (t) => {
  const { ipc, pipe, warns } = setup(t)
  let ran = 0
  ipc.handle('thing:do', async () => { ran += 1; return { ok: true } })
  ipc.start()

  pipe.feed({ id: 1, type: 'thing:do' })
  await flush()

  t.is(ran, 0, 'the handler was never invoked')
  const reply = pipe.reply(1)
  t.is(reply.code, INVALID_ARGUMENT, 'the caller is told the argument was bad')
  t.is(reply.error, 'missing required field: spaceId', 'and which one')
  t.ok(warns.some((l) => l.includes('req-invalid')), 'and it is visible at the default level')
  t.is(getRequestFailureCounters()['thing:do:INVALID_ARGUMENT'], 1, 'and counted')
})

test('a wrongly-typed optional field is refused too', async (t) => {
  const { ipc, pipe } = setup(t)
  let ran = 0
  ipc.handle('thing:do', async () => { ran += 1 })
  ipc.start()

  pipe.feed({ id: 2, type: 'thing:do', spaceId: 's1', count: 'seven' })
  await flush()

  t.is(ran, 0)
  t.is(pipe.reply(2).code, INVALID_ARGUMENT)
})

test('a valid request still reaches its handler unchanged', async (t) => {
  const { ipc, pipe, warns } = setup(t)
  let seen = null
  ipc.handle('thing:do', async (msg) => { seen = msg; return { got: msg.spaceId } })
  ipc.start()

  pipe.feed({ id: 3, type: 'thing:do', spaceId: 's1', count: 2 })
  await flush()

  t.is(seen.spaceId, 's1', 'the handler got the whole message')
  t.alike(pipe.reply(3).data, { got: 's1' }, 'and its result was returned')
  t.absent(warns.find((l) => l.includes('req-invalid')), 'no warn for a good request')
})

test('a no-input request validates trivially', async (t) => {
  const { ipc, pipe } = setup(t)
  ipc.handle('thing:free', async () => ({ fine: true }))
  ipc.start()

  pipe.feed({ id: 4, type: 'thing:free' })
  await flush()
  t.alike(pipe.reply(4).data, { fine: true }, 'the 32 no-input handlers keep working with an empty shape')
})
