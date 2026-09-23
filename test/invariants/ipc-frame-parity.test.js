import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import {
  FRAME, CONTROL_FRAMES, CLIENT_KINDS, TRUST,
  IPC_PROTOCOL_VERSION, IPC_PROTOCOL_MIN_SUPPORTED,
} from '../../src/shared/contract/ipc-frames.js'
import { REQUEST_NAMES } from '../../src/shared/contract/requests.js'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (rel) => readFileSync(path.join(root, rel), 'utf8')

// A control frame is a name the router branches on before the handler table is consulted. A frame
// the contract declares and the router ignores is a promise to a client that nothing keeps; a
// branch on a name the contract does not declare is a frame no other implementation can know to
// send.
test('every declared control frame has a branch in the router, and every branch a declaration', (t) => {
  const src = read('src/shared/core/ipc.js')
  const branched = [...src.matchAll(/msg\.type === FRAME\.([A-Z_]+)/g)].map((m) => FRAME[m[1]])
  // RESPONSE and HELLO_ACK are written, never read: the worker sends them and no client frame
  // carries either name inbound.
  const expected = CONTROL_FRAMES.filter((f) => f !== FRAME.RESPONSE && f !== FRAME.HELLO_ACK)
  t.alike([...new Set(branched)].sort(), [...expected].sort())
})

test('a frame name is a control frame or a request name, never both', (t) => {
  t.alike(CONTROL_FRAMES.filter((f) => REQUEST_NAMES.includes(f)), [])
})

test('the wire vocabulary is frozen and the version window is coherent', (t) => {
  t.ok(Object.isFrozen(FRAME) && Object.isFrozen(CLIENT_KINDS) && Object.isFrozen(TRUST))
  t.ok(IPC_PROTOCOL_MIN_SUPPORTED <= IPC_PROTOCOL_VERSION)
})

// A vocabulary with no reader is a rule nothing enforces: the trust tuple sat beside two sites that
// each typed their own literal, so a third spelling would have been as invisible as a wrong one.
test('every site that assigns or tests a client trust names it from the declaration', (t) => {
  const sites = {
    'src/shared/core/ipc.js': 'TRUST.HOST',
    'src/shared/core/ipc-client.js': 'TRUST.PEER',
    'src/shared/core/client-trust.js': 'TRUST.HOST',
  }
  for (const [file, expected] of Object.entries(sites)) {
    const src = read(file)
    t.ok(src.includes(expected), `${file} reads ${expected}`)
    t.absent(new RegExp(`trust[^\\n]*===\\s*'(host|peer)'|trust:\\s*'(host|peer)'`).test(src),
      `${file} carries no hand-typed trust literal`)
  }
})

// The ack's shape is the only thing a non-Electron client has to go on, so the fields it promises
// are asserted at the one place that writes them.
test('the hello-ack carries the stream coordinates and the trust it assigned', (t) => {
  const src = read('src/shared/core/ipc-handshake.js')
  const at = src.indexOf('FRAME.HELLO_ACK,\n      ok: true,')
  t.ok(at > 0, 'the accepting ack is written in one place')
  const ack = src.slice(at, at + 700)
  for (const field of ['protocolVersion', 'protocolMin', 'protocolMax', 'trust', 'epoch', 'head', 'resume']) {
    t.ok(new RegExp(`\\b${field}:`).test(ack), `${field} rides the ack`)
  }
})

// The hello's cursor was minted before this socket existed, so its replay stops where the socket
// joined; a resume the client ASKS for states what that client holds now, and the renderer asks
// over main's pipe, which joined before the first frame. Bounding that one by the attach point
// replays nothing, ever.
test('the requested resume is bounded by the cursor and the hello by the attach point', (t) => {
  const worker = read('src/worker/ipc/worker-process.js')
  t.ok(/ipc\.resume\(ctx\.client,[\s\S]{0,120}?\{ sinceAttach: false \}\)/.test(worker),
    'the events:resume handler answers for the caller, not for its socket')
  const handshake = read('src/shared/core/ipc-handshake.js')
  t.ok(/events\.resume\(client, verdict\.cursor\)/.test(handshake),
    'and the hello keeps the attach-point default')
})
