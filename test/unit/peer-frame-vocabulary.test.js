import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import {
  PEER_FRAME, PEER_FRAMES, IDENTITY_ASSERTING, MEMBERSHIP_CONTROL_FRAMES,
} from '../../src/shared/contract/peer-frames.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..', '..', 'src')
const read = (rel) => readFileSync(path.join(root, rel), 'utf8')

// Source-scanned rather than imported: the dispatch table lives in frame-intake.js, which pulls in the
// Hyper stack and cannot load under a Node runner.
const intake = read('shared/network/frame-intake.js')

test('every declared frame has a handler in the dispatch table', (t) => {
  const table = intake.slice(intake.indexOf('const PEER_FRAME_HANDLERS'), intake.indexOf('function toMembershipControl'))
  t.ok(table.length > 0, 'found the dispatch table')

  const routed = new Set([...table.matchAll(/\[PEER_FRAME\.([A-Z_]+)\]/g)].map((m) => m[1]))
  for (const [name, value] of Object.entries(PEER_FRAME)) {
    t.ok(routed.has(name), `${value} is routed`)
  }
})

test('the dispatch table routes nothing the contract does not declare', (t) => {
  const table = intake.slice(intake.indexOf('const PEER_FRAME_HANDLERS'), intake.indexOf('function toMembershipControl'))
  for (const m of table.matchAll(/\[PEER_FRAME\.([A-Z_]+)\]/g)) {
    t.ok(m[1] in PEER_FRAME, `PEER_FRAME.${m[1]} exists`)
  }
})

// The other half of the contract: a frame nothing sends is dead vocabulary, and a frame sent under a
// spelling the table does not know is silently dropped at the far end.
test('every declared frame is sent somewhere, and no send names a raw literal', (t) => {
  const files = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name)
      if (statSync(p).isDirectory()) { if (name !== 'vendor') walk(p) }
      else if (name.endsWith('.js')) files.push(p)
    }
  }
  walk(path.join(root, 'shared'))
  walk(path.join(root, 'worker'))

  const sent = new Set()
  for (const file of files) {
    if (file.endsWith(path.join('contract', 'peer-frames.js'))) continue
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(/type:\s*PEER_FRAME\.([A-Z_]+)/g)) sent.add(m[1])
    for (const value of PEER_FRAMES) {
      t.absent(new RegExp(`type:\\s*'${value}'`).test(src),
        `${path.relative(root, file)} names ${value} through PEER_FRAME`)
    }
  }

  for (const [name, value] of Object.entries(PEER_FRAME)) {
    t.ok(sent.has(name), `${value} is sent by something`)
  }
})

test('the identity-asserting pair is exactly the two frames that claim a profileKey', (t) => {
  t.alike([...IDENTITY_ASSERTING], [PEER_FRAME.HANDSHAKE, PEER_FRAME.MEMBERSHIP_REQUEST])
  t.ok(intake.includes('IDENTITY_ASSERTING.includes(msg.type)'),
    'and the admission gate reads it rather than re-listing the pair')
})

// cancel-ack is answered by the swarm itself, so a handler table that adopted it would send a frame
// the worker has no verb for.
test('the membership control set is the four the worker handles, without cancel-ack', (t) => {
  t.alike([...MEMBERSHIP_CONTROL_FRAMES], [
    PEER_FRAME.MEMBERSHIP_REQUEST, PEER_FRAME.MEMBERSHIP_GRANT,
    PEER_FRAME.MEMBERSHIP_DENY, PEER_FRAME.MEMBERSHIP_CANCEL,
  ])
  t.absent(MEMBERSHIP_CONTROL_FRAMES.includes(PEER_FRAME.MEMBERSHIP_CANCEL_ACK))

  const main = read('worker/ipc/membership.js')
  const table = main.slice(main.indexOf('const MEMBERSHIP_HANDLERS'), main.indexOf('async function handleMembershipControl'))
  const handled = new Set([...table.matchAll(/\[PEER_FRAME\.([A-Z_]+)\]/g)].map((m) => m[1]))
  for (const value of MEMBERSHIP_CONTROL_FRAMES) {
    const name = Object.keys(PEER_FRAME).find((k) => PEER_FRAME[k] === value)
    t.ok(handled.has(name), `the worker handles ${value}`)
  }
  t.is(handled.size, MEMBERSHIP_CONTROL_FRAMES.length, 'and handles nothing else')
})
