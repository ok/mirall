import test from 'brittle'
import { EventEmitter } from 'events'
import { createIPC } from '../../src/shared/core/ipc.js'
import { sayHello } from '../helpers/ipc-hello.js'
import { capture } from '../helpers/capture-console.js'
import { setVerbose } from '../helpers/runtime-verbose.js'

const TEST_REQUESTS = Object.freeze({
  'ping': { kind: 'query', args: {} },
  'identity:unlock': { kind: 'command', args: { kek: { type: 'string', max: 64 } } },
})

function fakePipe() {
  const ee = new EventEmitter()
  ee.written = []
  ee.write = (s) => { ee.written.push(s); return true }
  ee.feedRaw = (str) => ee.emit('data', Buffer.from(str))
  ee.of = (type) => ee.written.map((l) => JSON.parse(l)).filter((f) => f.type === type)
  return ee
}

const KEK = 'c0ffee'.repeat(10) + 'beef'

test('a frame that is not JSON is skipped and logged by its length, never its content', (t) => {
  setVerbose(t, true)
  const lines = capture(t, ['log', 'warn', 'error'])
  const pipe = fakePipe()
  const ipc = createIPC(pipe, { requests: TEST_REQUESTS })
  sayHello(pipe)
  ipc.start()
  // A parser's message quotes the start of its input, so a line that opens with the key is the
  // one that would leak it.
  pipe.feedRaw(KEK + '\n')
  pipe.feedRaw('x{"id":1,"type":"identity:unlock","kek":"' + KEK + '"}\n')
  const all = [...lines.log, ...lines.warn, ...lines.error].join('\n')
  t.ok(all.includes('skipped unparseable frame'), 'the skip is logged at the verbose level')
  t.absent(all.includes(KEK.slice(0, 8)), 'and no part of the line it skipped')
  t.is(pipe.of('response').length, 0, 'nothing answered a frame that never parsed')
})

test('going live again greets every attached client with the greeter now installed', async (t) => {
  const host = fakePipe()
  const other = fakePipe()
  const ipc = createIPC(host, { requests: TEST_REQUESTS })
  ipc.attach(other)
  sayHello(host)
  sayHello(other)
  const greeted = []
  ipc.onClientAttach((client) => { greeted.push(['recovery', client.id]) })
  ipc.start()
  await new Promise((resolve) => setTimeout(resolve, 0))
  ipc.onClientAttach((client) => { greeted.push(['full', client.id]) })
  ipc.start()
  await new Promise((resolve) => setTimeout(resolve, 0))
  t.alike(greeted, [['recovery', 1], ['recovery', 2], ['full', 1], ['full', 2]])
})
